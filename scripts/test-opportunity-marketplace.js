const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Opportunity = require("../src/models/Opportunity");
const Grant = require("../src/models/OpportunityGrant");
const Wallet = require("../src/models/WalletTransaction");
const User = require("../src/models/User");
const Project = require("../src/models/Project");
const { paidProjectAccess } = require("../src/services/paidProjectAccess");
const Role = require("../src/models/WorkPosition");
const ApplyWork = require("../src/models/ApplyWork");
const Order = require("../src/models/Order");
const Service = require("../src/models/Service");
const Withdrawal = require("../src/models/WithdrawalRequest");

const port = process.env.UREMO_TEST_MONGO_PORT;
test("project marketplace through mounted HTTP routes", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  delete process.env.RESEND_API_KEY;
  const uri = "mongodb://127.0.0.1:" + port + "/uremo_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await Promise.all([Grant.init(), Opportunity.init(), Wallet.init(), Role.init(), ApplyWork.init(), User.init()]);
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  const users = Array.from({ length: 6 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), name: "QA " + index, email: "qa" + index + "@example.test",
    role: index === 0 ? "admin" : "user", walletBalance: index === 5 ? 0.3 : 200,
  }));
  await User.collection.insertMany(users);
  const [admin, buyer, renter, applicant, other, small] = users;
  const readBalance = async user => (await User.findById(user._id).select("walletBalance")).walletBalance;
  async function req(route, who, method = "GET", body) {
    const headers = { "content-type": "application/json" };
    if (who) headers.authorization = "Bearer " + jwt.sign({ id: String(who._id), role: who.role }, process.env.JWT_SECRET);
    const response = await fetch(base + route, { method, headers, body: JSON.stringify(body) });
    return { ...await response.json(), status: response.status, headers: response.headers };
  }
  const adminApi = "/admin/opportunities", api = "/opportunities";
  async function updateListing(item, fields) {
    const path = adminApi + "/" + item._id;
    const detail = await req(path, admin);
    return req(path, admin, "PATCH", { expectedRevision: detail.opportunity.revision, ...fields });
  }
  const offer = { title: "Synthetic design brief", description: "Source assets and handoff for a test project",
    category: "design", status: "published", rightsConfirmed: true, rentEnabled: true, rentalDays: 3,
    rentPrice: 4.25, buyEnabled: true, buyPrice: 25, deliverable: "PRIVATE-" + randomUUID() };
  const terms = type => type === "rent" ? { requestId: randomUUID(), expectedAmount: 4.25, expectedRentalDays: 3 } :
    { requestId: randomUUID(), expectedAmount: 25 };
  const makeRole = () => Role.create({ title: "QA role", category: "Design", active: true });
  const mainRole = await makeRole();
  await ApplyWork.create({ position: mainRole._id, user: renter._id, status: "approved", workerStatus: "working",
    currentProject: new mongoose.Types.ObjectId() });
  const makeProject = (role = mainRole, fields = {}) => Project.create({ title: "Scoped project", description: "Private brief",
    workPositionId: role._id, category: role.category, status: "open", payRate: 0, ...fields });
  async function create(extra = {}) {
    const projectId = extra.projectId || (await makeProject())._id;
    const result = await req(adminApi, admin, "POST", { ...offer, ...extra, projectId });
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.opportunity;
  }
  const charge = (item, user, mode, body = terms(mode)) => req(api + "/" + item._id + "/" + mode, user, "POST", body);
  const access = (item, user) => req(api + "/" + item._id + "/access", user);

  await t.test("reviewed rent and sale refunds repay exactly once, revoke all access and leave the offer closed", async () => {
    const { acquiredProjects } = require("../src/services/profileProjects");
    for (const [type, member] of [["rent", renter], ["buy", buyer]]) {
      const item = await create({});
      const balance = await readBalance(member);
      const request = terms(type);
      const chargeResult = await charge(item, member, type, request);
      assert.equal(chargeResult.status, 201);
      const id = chargeResult.grant._id, path = adminApi + "/receipts/" + id + "/refund";
      const review = { reason: "Confirmed delivery issue" };
      assert.equal((await req(path, member, "POST", review)).status, 403);
      assert.equal((await req(path, admin, "POST", { reason: "" })).status, 400);
      const refunds = await Promise.all([req(path, admin, "POST", review), req(path, admin, "POST", review)]);
      assert.deepEqual(refunds.map(r => r.status), [200, 200]);
      assert.equal(refunds[0].refundTransactionId, refunds[1].refundTransactionId);
      assert.equal(await readBalance(member), balance);
      assert.equal(await Wallet.countDocuments({ referenceId: id, source: "refund" }), 1);
      assert.equal(await Wallet.countDocuments({ referenceId: id, type: "debit" }), 1);
      assert.equal((await Opportunity.findById(item._id)).status, "archived");
      assert.equal((await access(item, member)).status, 403);
      assert.equal((await req(api + "/" + item._id, member)).status, 404);
      assert.equal((await acquiredProjects(member._id, item.projectId)).length, 0);
      assert.equal((await (paidProjectAccess(member._id, [item.projectId]))).get(item.projectId).active, false);
      assert.equal((await charge(item, member, type, request)).grant.active, false);
      const receipt = (await req(api + "/mine", member)).grants.find(r => r._id === id);
      assert.ok(receipt.refundedAt); assert.equal(receipt.refundReason, undefined);
      const recorded = await Grant.findById(id).select("+refundedBy +refundReason");
      assert.equal(recorded.refundReason, review.reason); assert.equal(String(recorded.refundedBy), String(admin._id));
    }
  });

  await t.test("every historical and current listing revision guards its full editor and status actions", async () => {
    const item = await create({});
    const path = adminApi + "/" + item._id;
    assert.equal((await req(path, buyer, "PATCH", { expectedRevision: item.revision, status: "archived" })).status, 403);
    assert.equal((await req(path, admin, "PATCH", { status: "archived" })).status, 428);
    const changes = await Promise.all(["One", "Two"].map(title => req(path, admin, "PATCH", { expectedRevision: item.revision, title })));
    assert.deepEqual(changes.map(x => x.status).sort(), [200,409]);
    const saved = changes.find(x => x.status === 200).opportunity;
    assert.notEqual(saved.revision, item.revision);
    assert.equal((await req(path, admin, "PATCH", { expectedRevision: item.revision, rightsConfirmed: false, status: "draft" })).status, 409);
    for (const field of ["soldAt", "rentedUntil", "userId", "firstPublishedAt", "applicationCount", "preserveRoleUntilPublished"]) {
      assert.equal((await req(path, admin, "PATCH", { expectedRevision: saved.revision, [field]: null })).status, 400);
    }
    const grant = await charge(item, renter, "rent");
    assert.equal(grant.status, 201);
    assert.equal((await req(path, admin, "PATCH", { expectedRevision: saved.revision, status: "archived" })).status, 409);
    assert.equal((await updateListing(item, { status: "archived", deliverable: "Changed later", rentPrice: 20, rentalDays: 14 })).status, 200);
    assert.equal((await access(item, renter)).deliverable, offer.deliverable);
    assert.equal((await access(item, other)).status, 403);
    assert.equal((await Grant.findById(grant.grant._id)).amount, offer.rentPrice);
    await Opportunity.collection.updateOne({ _id: new mongoose.Types.ObjectId(item._id) }, { $unset: { updatedAt: "", createdAt: "" } });
    assert.equal((await updateListing(item, { description: "Historical row edited safely" })).status, 200);
  });

  await t.test("role settings keep exact screening order, validated private training, stale protections and references", async () => {
    const roles = "/admin/work-positions";
    const createRole = () => req(roles, admin, "POST", { title: "Design researcher", category: "design", adminNotes: "internal-fixture", active: true, sortOrder: 2 });
    assert.equal((await req(roles, other, "POST", { title: "bad" })).status, 403);
    assert.equal((await req(roles, admin, "POST", { title: "bad", category: "design", active: "false" })).status, 400);
    const role = await createRole();
    assert.equal(role.status, 201);
    const path = roles + "/" + role._id, settings = "/admin/workspace/job/" + role._id;
    assert.equal((await req(settings, admin)).job.revision, role.revision);
    assert.equal((await req(path, other, "DELETE")).status, 403);
    const edited = await req(path, admin, "PUT", { expectedRevision: role.revision, description: "Edited role", requirements: "A portfolio", sortOrder: -2 });
    assert.equal(edited.status, 200);
    assert.equal(edited.adminNotes, "internal-fixture");
    assert.equal((await req(path, admin, "PUT", { expectedRevision: role.revision, title: "stale" })).status, 409);
    assert.equal((await req(settings + "/set-training", admin, "PUT", { trainingMaterials: [{ title: "unsafe", url: "javascript:alert(1)" }] })).status, 400);
    const trained = await req(settings + "/set-training", admin, "PUT", { expectedRevision: edited.revision,
      trainingMaterials: [{ title: "Reading", url: "https://example.invalid/reading", type: "pdf" }] });
    assert.equal(trained.status, 200);
    const Screening = require("../src/models/Screening");
    const one = await Screening.create({ title: "A", category: "writing" });
    const two = await Screening.create({ title: "B", category: "writing" });
    assert.equal((await req(settings + "/set-screening", admin, "PUT", { screeningIds: [one._id, new mongoose.Types.ObjectId()] })).status, 404);
    assert.equal((await req(settings + "/set-screening", admin, "PUT", { screeningIds: [] , expectedRevision: edited.revision })).status, 409);
    const screened = await req(settings + "/set-screening", admin, "PUT", { screeningIds: [two._id, one._id], expectedRevision: trained.job.revision });
    assert.equal(screened.status, 200);
    assert.deepEqual(screened.job.screeningIds.map(x => x._id), [String(two._id), String(one._id)]);
    const application = await ApplyWork.create({ user: other._id, position: role._id, category: "design" });
    const firstReview = await req(settings + "/approve", admin, "PUT", { applicantId: application._id });
    assert.equal(firstReview.status, 200);
    assert.equal(firstReview.applicant.workerStatus, "screening_unlocked");
    await ApplyWork.updateOne({ _id: application._id }, { $set: { workerStatus: "working", currentProject: new mongoose.Types.ObjectId() } });
    assert.equal((await req("/apply-work/admin/" + application._id, admin, "PUT", { status: "approved" })).workerStatus, "working");
    assert.equal((await req(settings + "/reject", admin, "PUT", { applicantId: application._id })).status, 409);
    assert.equal((await req(settings + "/unlock-screening", admin, "PUT", { applicantId: application._id })).status, 409);
    const linked = await create({ projectId: (await makeProject(role))._id });
    assert.equal((await req(path, admin, "DELETE", { expectedRevision: screened.job.revision })).status, 409);
    assert.equal((await req(path, admin, "PUT", { active: false })).status, 200);
    assert.equal((await req(api + "/" + linked._id)).opportunity.applyEnabled, false);
    assert.equal((await req(path, admin, "PUT", { active: true })).status, 200);
    const solo = await createRole();
    assert.equal((await req(roles + "/" + solo._id, admin, "DELETE", { expectedRevision: solo.revision })).status, 200);
    assert.equal((await req(settings + "/set-screening", admin, "PUT", { screeningIds: [] })).job.hasScreening, false);
  });

  await t.test("role assignment, activation and earnings protect completed work and competing admins", async t => {
    const Project = require("../src/models/Project");
    const role = await Role.create({ title: "Researcher", category: "research", active: true });
    const custom = await Role.create({ title: "Cultural editor", category: "Museum studies", active: true });
    const customProject = await req("/admin/workspace/projects", admin, "POST", { title: "Exhibit review", workPositionId: custom._id, priority: "urgent" });
    assert.equal(customProject.status, 201, JSON.stringify(customProject));
    assert.equal(customProject.project.category, "Museum studies");
    assert.equal(customProject.project.priority, "urgent");
    assert.equal((await req("/admin/workspace/projects", admin, "POST", { title: "Invalid", category: 8 })).status, 400);
    const alien = await makeRole();
    const projectApi = "/admin/workspace/project/";
    const roleApi = "/admin/workspace/job/" + role._id;
    const created = await req(roleApi + "/projects", admin, "POST", { title: "Research brief", payRate: 25, priority: "urgent" });
    assert.equal(created.status, 201, JSON.stringify(created));
    const project = created.project;
    assert.equal(project.category, "research");
    assert.equal(project.priority, "urgent");
    assert.equal((await req(projectApi + project._id, admin, "PUT", { priority: "high" })).project.priority, "high");
    assert.equal((await req("/admin/workspace/job/" + alien._id + "/projects/" + project._id + "/activate", admin, "PUT", {})).status, 409);
    assert.equal((await req(roleApi + "/projects/" + project._id + "/activate", admin, "PUT", {})).status, 200);
    const newUser = async () => {
      const _id = new mongoose.Types.ObjectId();
      await User.collection.insertOne({ _id, role: "user", walletBalance: 10, withdrawable: 5, email: String(_id) + "@example.invalid" });
      return _id;
    };
    const workers = await Promise.all([1,2].map(async () => ApplyWork.create({ user: await newUser(), position: role._id,
      status: "approved", workerStatus: "ready_to_work", category: "research" })));
    const choice = new mongoose.Types.ObjectId();
    await Project.updateOne({ _id: project._id }, { $set: { screeningIds: [choice] } });
    assert.equal((await req(projectApi + project._id + "/eligible-workers", admin)).workers.length, 0);
    assert.equal((await req(projectApi + project._id + "/assign", admin, "PUT", { workerId: workers[0]._id })).status, 409);
    await ApplyWork.updateMany({ position: role._id }, { $push: { screeningsCompleted: { screeningId: choice, passed: true } } });
    assert.equal((await req(projectApi + project._id + "/eligible-workers", admin)).workers.length, 2);
    const replies = await Promise.all([
      req(roleApi + "/assign-project", admin, "PUT", { applicantId: workers[0]._id, projectId: project._id }),
      req(projectApi + project._id + "/assign", admin, "PUT", { workerId: workers[1]._id }),
    ]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200,409]);
    const winner = workers[replies[0].status === 200 ? 0 : 1];
    const loser = workers[replies[0].status === 200 ? 1 : 0];
    assert.equal((await req(projectApi + project._id, admin, "PUT", { status: "completed" })).status, 409);
    const cancelled = (await req(roleApi + "/projects", admin, "POST", { title: "Cancelled assignment" })).project;
    assert.equal((await req(roleApi + "/projects/" + cancelled._id + "/activate", admin, "PUT", {})).status, 200);
    assert.equal((await req(projectApi + cancelled._id + "/assign", admin, "PUT", { workerId: loser._id })).status, 200);
    assert.equal((await req(projectApi + cancelled._id, admin, "PUT", { status: "cancelled" })).status, 200);
    assert.equal((await ApplyWork.findById(loser._id)).currentProject, null);
    assert.equal((await req(projectApi + cancelled._id, admin, "DELETE")).status, 409);
    assert.equal((await req("/workspace/project/" + cancelled._id + "/submit", { _id: loser.user }, "POST", {})).status, 409);
    const Proof = require("../src/models/ProofOfWork");
    const proofId = new mongoose.Types.ObjectId();
    await Proof.collection.insertOne({ _id: proofId, projectId: cancelled._id, jobRoleId: role._id, workerId: loser.user, status: "pending" });
    assert.equal((await req("/admin/proofs/" + proofId + "/approve", admin, "PUT", {})).status, 409);
    assert.equal((await Proof.findById(proofId)).status, "pending");
    assert.equal((await req(roleApi + "/credit-worker", admin, "PUT", { applicantId: winner._id, amount: 25 })).status, 409);
    assert.equal((await req(projectApi + project._id + "/credit", admin, "PUT", { amount:25 })).status, 409);
    const validProof = new mongoose.Types.ObjectId();
    await Proof.collection.insertOne({ _id: validProof, projectId: new mongoose.Types.ObjectId(project._id), jobRoleId: role._id, workerId: winner.user, status: "pending",
      submissionText: "Isolated synthetic proof" });
    assert.equal((await req("/admin/proofs/" + validProof + "/approve", admin, "PUT", {})).status, 200);
    assert.equal((await req(projectApi + project._id, admin, "PUT", { status: "open" })).status, 409);
    const failure = t.mock.method(Wallet, "create", async () => { throw Error("Synthetic earning ledger failure"); });
    const pay = () => req(projectApi + project._id + "/credit", admin, "PUT", { amount:25 });
    assert.equal((await pay()).status, 500);
    failure.mock.restore();
    assert.equal((await Project.findById(project._id)).earningsCredited, 0);
    assert.equal((await User.findById(winner.user)).walletBalance, 10);
    assert.deepEqual((await Promise.all([pay(),pay()])).map(r => r.status).sort(), [200,409]);
    const final = await User.findById(winner.user);
    assert.deepEqual([final.walletBalance, final.withdrawable, final.lifetimeEarnings], [35,30,25]);
    assert.equal(await Wallet.countDocuments({ referenceId: project._id, source: "earning" }), 1);
    assert.equal((await ApplyWork.findById(winner._id)).currentProject, null);
    assert.equal((await req(roleApi + "/projects/" + project._id + "/activate", admin, "PUT", {})).status, 409);
  });

  await t.test("admin project detail scopes the worker application and proof history to the actual assignment", async () => {
    const Project = require("../src/models/Project"), Proof = require("../src/models/ProofOfWork");
    const parent = await makeRole(), wrongRole = await makeRole();
    const member = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: member, name: "Preview researcher", role: "user", email: "research-fixture@example.invalid" });
    // The unrelated role was created first, as happens with a multi-role worker.
    await ApplyWork.create({ user: member, position: wrongRole._id, category: "design", status: "approved", workerStatus: "ready_to_work" });
    const project = await Project.create({ title: "Records audit", description: "Check the signed brief.", category: "design",
      payRate: 12, workPositionId: parent._id, assignedTo: member, status: "assigned", createdBy: admin._id });
    const right = await ApplyWork.create({ user: member, position: parent._id, currentProject: project._id, category: "design", status: "approved", workerStatus: "assigned" });
    const proof = await Proof.create({ workerId: member, jobRoleId: parent._id, projectId: project._id, submissionText: "First review attached" });
    await Proof.create({ workerId: member, jobRoleId: wrongRole._id, projectId: new mongoose.Types.ObjectId(), submissionText: "Separate review" });
    const path = "/admin/workspace/project/" + project._id;
    assert.equal((await req(path, buyer)).status, 403);
    const detail = await req(path, admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.project.description, "Check the signed brief.");
    assert.equal(detail.project.workPositionId._id, String(parent._id));
    assert.equal(detail.project.assignedTo.name, "Preview researcher");
    assert.equal(detail.workerProfile._id, String(right._id));
    assert.equal(detail.workerProfile.user.name, "Preview researcher");
    assert.equal(detail.workerProfile.position._id, String(parent._id));
    assert.equal(detail.workerProfile.position.title, parent.title);
    assert.deepEqual(detail.proofs.map(p => p._id), [String(proof._id)]);
    assert.equal(detail.proofs[0].jobRoleId._id, String(parent._id));
    assert.equal(detail.proofs[0].workerId.name, "Preview researcher");
    await ApplyWork.deleteOne({ _id: right._id });
    assert.equal((await req(path, admin)).workerProfile, null);
    assert.equal((await req("/admin/workspace/project/invalid", admin)).status, 400);
    await ApplyWork.create({ user: member, position: parent._id, category: "design", workerStatus: "working" });
    await ApplyWork.create({ user: other._id, position: parent._id, category: "design", workerStatus: "assigned" });
    await ApplyWork.create({ user: renter._id, position: parent._id, category: "design", workerStatus: "applied" });
    const applicants = "/admin/workspace/job/" + parent._id + "/applicants?";
    const first = await req(applicants + "workerStatus=assigned,working&limit=1&page=1", admin);
    const second = await req(applicants + "workerStatus=assigned,working&limit=1&page=2", admin);
    assert.equal(first.total, 2);
    assert.equal(first.pages, 2);
    assert.notEqual(first.applicants[0]._id, second.applicants[0]._id);
    for (const query of ["workerStatus=bogus", "workerStatus=assigned,", "page=0", "limit=101"]) {
      assert.equal((await req(applicants + query, admin)).status, 400);
    }
  });

  await t.test("admin drafts, private/public field boundaries, category, terms and publication checks", async () => {
    assert.equal((await req(adminApi)).status, 401);
    assert.equal((await req(adminApi, buyer)).status, 403);
    const draft = await req(adminApi, admin, "POST", { status: "draft", projectId: (await makeProject())._id });
    assert.equal(draft.status, 201);
    assert.equal((await req(api + "/" + draft.opportunity._id)).status, 404);
    for (const change of [{ rightsConfirmed: false }, { category: "forex_crypto" }, { rentPrice: 1.001 },
         { rentalDays: 0 }, { deliverable: "" }, { workPositionId: new mongoose.Types.ObjectId(), applyEnabled: true },
         { soldAt: new Date() }]) {
      const invalid = await req(adminApi, admin, "POST", { ...offer, projectId: (await makeProject())._id, ...change });
      assert.equal(invalid.status, 400, JSON.stringify(invalid));
    }
    const item = await create({});
    const detail = await req(api + "/" + item._id);
    assert.equal(detail.status, 200);
    assert.equal(detail.opportunity.availability, "available");
    assert.equal(detail.opportunity.deliverable, undefined);
    assert.equal(detail.opportunity.rightsConfirmed, undefined);
    assert.doesNotMatch(JSON.stringify((await req(api)).opportunities), /PRIVATE-/);
    assert.equal((await req(adminApi + "/" + item._id, admin)).opportunity.deliverable, offer.deliverable);
    assert.doesNotMatch(JSON.stringify((await req(adminApi, admin)).opportunities), /PRIVATE-/);
    assert.equal((await access(item, buyer)).status, 403);
    assert.equal((await access(item)).status, 401);
  });

  await t.test("a revised project scope requires fresh consent and the purchased scope survives archiving", async () => {
    const item = await create({});
    const fresh = await updateListing(item, { description: "Updated project scope" });
    const before = await readBalance(buyer);
    const outdated = await charge(item, buyer, "buy", { ...terms("buy"), expectedRevision: item.revision });
    assert.equal(outdated.status, 409);
    assert.equal(await readBalance(buyer), before);
    const paid = await charge(item, buyer, "buy", { ...terms("buy"), expectedRevision: fresh.opportunity.revision });
    assert.equal(paid.status, 201);
    await updateListing(item, { status: "archived" });
    assert.equal((await access(item, buyer)).grant.projectScope, "Updated project scope");
  });
  await t.test("insufficient wallet, foreign role, stale price and inactive option never charge", async () => {
    const item = await create({});
    const before = await readBalance(small);
    assert.equal((await charge(item, null, "buy")).status, 401);
    assert.equal((await charge(item, small, "buy")).status, 402);
    assert.equal((await charge(item, renter, "rent", { ...terms("rent"), expectedRentalDays: 2 })).status, 409);
    assert.equal((await charge(item, buyer, "buy", { ...terms("buy"), expectedAmount: 10 })).status, 409);
    assert.equal(await readBalance(small), before);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "available");
    assert.equal(await Grant.countDocuments({ opportunityId: item._id }), 0);
    await updateListing(item, { buyEnabled: false });
    assert.equal((await charge(item, buyer, "buy")).status, 409);
  });

  await t.test("eight identical checkout retries charge one time; competing buyer gets no rights", async () => {
    const item = await create({});
    const same = terms("buy");
    const before = await readBalance(buyer);
    const results = await Promise.all(Array.from({ length: 8 }, () => charge(item, buyer, "buy", same)));
    assert.deepEqual(results.map(r => r.status).sort(), [200,200,200,200,200,200,200,201]);
    assert.equal(results.filter(r => !r.replayed).length, 1);
    assert.equal(new Set(results.map(r => r.grant._id)).size, 1);
    assert.equal(await readBalance(buyer), before - offer.buyPrice);
    const grantId = results[0].grant._id;
    assert.equal(await Wallet.countDocuments({ referenceId: grantId, source: "service_purchase", status: "success" }), 1);
    assert.equal((await access(item, buyer)).deliverable, offer.deliverable);
    assert.equal((await access(item, other)).status, 403);
    // The immutable receipt still closes the project if a historical repair
    // removed the mutable sold marker.
    await Opportunity.updateOne({ _id: item._id }, { soldAt: null });
    assert.equal((await charge(item, other, "buy")).status, 409);
    assert.equal((await charge(item, other, "rent")).status, 409);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "sold");
    assert.equal((await req(api)).opportunities.some(r => r._id === item._id), false);
    await Opportunity.updateOne({ _id: item._id }, { soldAt: new Date() });
    assert.equal((await updateListing(item, { status: "published" })).status, 409);
    assert.equal((await updateListing(item, { status: "archived" })).status, 200);
    assert.equal((await access(item, buyer)).status, 200);
    assert.equal((await charge(item, buyer, "buy", same)).replayed, true);
    assert.doesNotMatch(JSON.stringify((await req(api + "/mine", buyer)).grants), /PRIVATE-/);
    assert.equal((await charge(await create({}), buyer, "buy", same)).status, 409);
  });

  await t.test("different buyers racing a rental and a purchase cannot both settle", async () => {
    const item = await create({});
    const [a,b] = await Promise.all([charge(item, renter, "rent"), charge(item, other, "buy")]);
    assert.deepEqual([a.status,b.status].sort(), [201,409]);
    const grants = await Grant.find({ opportunityId: item._id });
    assert.equal(grants.length, 1);
    assert.equal(await Wallet.countDocuments({ referenceId: grants[0]._id }), 1);
  });

  await t.test("one idempotency key cannot pay for two different listings concurrently", async () => {
    const pair = await Promise.all([create({}), create({})]);
    const attempt = terms("buy");
    const before = await readBalance(other);
    const replies = await Promise.all(pair.map(item => charge(item, other, "buy", attempt)));
    assert.deepEqual(replies.map(r => r.status).sort(), [201,409]);
    assert.equal(await readBalance(other), before - offer.buyPrice);
    assert.equal(await Opportunity.countDocuments({ _id: { $in: pair.map(x => x._id) }, soldAt: { $ne: null } }), 1);
    assert.equal(await Grant.countDocuments({ userId: other._id, requestId: attempt.requestId }), 1);
  });

  await t.test("work roles remain free to apply after sale and legacy product roles stay hidden", async () => {
    const role = await makeRole();
    const item = await create({ projectId: (await makeProject(role))._id });
    assert.equal((await charge(item, buyer, "buy")).status, 201);
    const apply = user => req("/apply-work", user, "POST", { positionId: role._id, resumeUrl: "https://example.invalid/cv" });
    const start = await readBalance(applicant);
    assert.deepEqual((await Promise.all([apply(applicant), req("/workspace/apply/" + role._id, applicant, "POST", {})])).map(r => r.status).sort(), [201,409]);
    assert.equal(await readBalance(applicant), start);
    assert.equal((await access(item, applicant)).status, 403);
    const custom = await Role.create({ title: "Financial analyst", category: "Finance research" });
    const retired = await Role.create({ title: "Legacy catalog fixture", category: "forex_accounts" });
    const source = await Service.collection.insertOne({ title: "Retired", category: "banks_gateways_wallets", slug: randomUUID() });
    const backed = await Role.create({ title: "Misleading label", category: "design", serviceId: source.insertedId });
    const listed = Object.values(await req("/work-positions")).map(row => row?._id);
    const adminRoles = Object.values(await req("/admin/work-positions", admin)).filter(row => row?._id);
    assert.equal(adminRoles.find(row => row._id === String(custom._id)).isSpecialization, true);
    assert.ok(listed.includes(String(role._id)) && listed.includes(String(custom._id)));
    for (const blocked of [backed, retired]) {
      assert.equal(adminRoles.find(row => row._id === String(blocked._id)).isSpecialization, false);
      assert.ok(!listed.includes(String(blocked._id)));
      assert.equal((await req("/workspace/apply/" + blocked._id, other, "POST", {})).status, 404);
      assert.equal((await req("/apply-work", other, "POST", { positionId: blocked._id, resumeUrl: "https://example.invalid/cv" })).status, 404);
      assert.equal((await req(adminApi, admin, "POST", { ...offer, projectId: (await makeProject(blocked))._id })).status, 400);
    }
    assert.equal((await req("/work-positions/by-service/" + backed.serviceId)).status, 404);
    await Role.updateOne({ _id: role._id }, { active: false });
    assert.equal((await apply(other)).status, 400);
  });

  await t.test("public briefs, qualified specialization rental, independent full access, snapshots and expiry", async () => {
    const role = await makeRole(), one = new mongoose.Types.ObjectId(), two = new mongoose.Types.ObjectId();
    const Screening = require("../src/models/Screening");
    await Screening.collection.insertMany([one, two].map(_id => ({ _id, title: "Required test", category: "writing", active: true })));
    await Role.updateOne({ _id: role._id }, { hasScreening: true, screeningId: one });
    const project = await makeProject(role, { screeningIds: [two] });
    const publish = () => req(adminApi, admin, "POST", { ...offer, projectId: project._id });
    assert.match((await publish()).message, /link every required project screening/i);
    await Role.updateOne({ _id: role._id }, { screeningIds: [one, two] });
    await Screening.updateOne({ _id: two }, { active: false });
    assert.match((await publish()).message, /unavailable screenings/i);
    await Screening.updateOne({ _id: two }, { active: true });
    const item = await create({ projectId: project._id });
    assert.deepEqual([item.kind, item.needsReview, item.projectId, item.workPositionId, item.applyEnabled],
      ["project", false, String(project._id), String(role._id), false]);
    const detail = async user => (await req(api + "/" + item._id, user)).opportunity;
    const anon = await detail();
    assert.deepEqual([anon.canRent, anon.canBuy, anon.projectTitle, anon.workPositionTitle], [false, false, project.title, role.title]);
    assert.equal((await detail(other)).canBuy, true);
    const before = await readBalance(renter);
    const application = await ApplyWork.create({ user: renter._id, position: role._id, status: "pending", workerStatus: "assigned",
      currentProject: new mongoose.Types.ObjectId(), screeningsCompleted: [{ screeningId: one, passed: true }, { screeningId: two, passed: true }] });
    const denied = async () => {
      assert.equal((await detail(renter)).canRent, false);
      assert.equal((await charge(item, renter, "rent")).status, 403);
      assert.equal(await readBalance(renter), before);
    };
    await denied(); // Approval in another specialization does not qualify this worker.
    await ApplyWork.updateOne({ _id: application._id }, { status: "approved", "screeningsCompleted.1.submissionStatus": "rejected" });
    await denied();
    await ApplyWork.updateOne({ _id: application._id }, { workerStatus: "suspended", "screeningsCompleted.1.submissionStatus": "approved" });
    await denied();
    await ApplyWork.updateOne({ _id: application._id }, { workerStatus: "working" });
    assert.equal((await detail(renter)).canRent, true);
    const rented = await charge(item, renter, "rent");
    assert.equal(rented.status, 201, JSON.stringify(rented));
    assert.deepEqual([rented.grant.projectId, rented.grant.workPositionId], [String(project._id), String(role._id)]);
    const gate = async user => (await paidProjectAccess(user._id, [project._id])).get(String(project._id));
    assert.equal((await gate(renter)).state, "rented");
    assert.equal((await gate(buyer)).active, false);
    assert.equal((await detail(buyer)).canBuy, false);
    assert.equal((await charge(item, buyer, "buy")).status, 409);
    await updateListing(item, { deliverable: "REPLACEMENT-PRIVATE" });
    assert.equal((await access(item, renter)).deliverable, offer.deliverable);
    const expired = new Date(Date.now() - 1);
    await Grant.updateOne({ _id: rented.grant._id }, { endsAt: expired, startsAt: new Date(Date.now()-86400000) });
    await Opportunity.updateOne({ _id: item._id }, { rentedUntil: expired });
    assert.equal((await access(item, renter)).status, 403);
    assert.equal((await gate(renter)).state, "expired");
    assert.equal((await charge(item, buyer, "buy")).status, 201);
    assert.equal((await gate(buyer)).state, "owned");
    assert.equal((await access(item, buyer)).deliverable, "REPLACEMENT-PRIVATE");
    assert.equal((await Project.findById(project._id)).assignedTo, undefined);
    assert.equal(await ApplyWork.countDocuments({ user: buyer._id, position: role._id }), 0);
  });

  await t.test("legacy listings fail closed while prior receipts retain access and replays", async () => {
    const role = await makeRole();
    const legacy = await Opportunity.create({ ...offer, workPositionId: role._id, applyEnabled: true, firstPublishedAt: new Date() });
    const spare = await makeProject();
    const convert = { status: "draft", projectId: spare._id, applyEnabled: false };
    assert.equal((await req(api + "/" + legacy._id)).status, 404);
    assert.equal((await charge(legacy, buyer, "buy")).status, 404);
    assert.equal((await req(api)).opportunities.some(r => r._id === String(legacy._id)), false);
    assert.equal((await req(adminApi + "/" + legacy._id, admin)).opportunity.canConvert, true);
    assert.equal((await updateListing(legacy, { status: "published" })).status, 409);
    const prior = await Grant.create({ opportunityId: legacy._id, userId: other._id, type: "buy", requestId: randomUUID(),
      title: "Earlier sale", deliverable: "Historical handoff", amount: 25, startsAt: new Date(), balanceAfter: 100 });
    assert.equal((await req(adminApi + "/" + legacy._id, admin)).opportunity.canConvert, false);
    assert.equal((await updateListing(legacy, convert)).status, 409);
    assert.equal((await access(legacy, other)).deliverable, "Historical handoff");
    assert.equal((await charge(legacy, other, "buy", { expectedAmount: 25, requestId: prior.requestId })).replayed, true);
    assert.equal((await access(legacy, buyer)).status, 403);
    assert.equal((await updateListing(legacy, { status: "archived" })).status, 200);
    const fixable = await Opportunity.create({ ...offer, applyEnabled: true });
    const fixed = await updateListing(fixable, convert);
    assert.equal(fixed.status, 200);
    assert.deepEqual([fixed.opportunity.status, fixed.opportunity.kind, fixed.opportunity.firstPublishedAt], ["draft", "project", null]);
    assert.equal((await req(api + "/" + fixable._id)).status, 404);
    assert.equal((await updateListing(fixable, { status: "published" })).status, 200);
    assert.equal((await req(api + "/" + fixable._id)).status, 200);
  });

  await t.test("project identity, exclusive staffing and per-project inventory survive competing admins", async () => {
    const role = await makeRole();
    const project = await makeProject(role), another = await makeProject(role);
    const createAt = (id, extra = {}) => req(adminApi, admin, "POST", { ...offer, projectId: id, ...extra });
    assert.equal((await createAt(project._id, { workPositionId: mainRole._id })).status, 400);
    assert.equal((await createAt(project._id, { applyEnabled: true })).status, 400);
    assert.equal((await req(adminApi, admin, "POST", offer)).status, 400);
    const pair = await Promise.all([createAt(project._id), createAt(project._id)]);
    assert.deepEqual(pair.map(v => v.status).sort(), [201,409]);
    const item = pair.find(v => v.status === 201).opportunity;
    assert.equal((await createAt(another._id, { rentEnabled: false })).status, 201);
    assert.equal((await updateListing(item, { projectId: another._id })).status, 409);
    const candidate = await ApplyWork.create({ user: applicant._id, position: role._id, status: "approved", workerStatus: "ready_to_work" });
    const assign = p => req("/admin/workspace/project/" + p._id + "/assign", admin, "PUT", { workerId: candidate._id });
    assert.equal((await assign(project)).status, 409);
    assert.equal((await updateListing(item, { status: "archived" })).status, 200);
    assert.equal((await assign(project)).status, 409);
    const race = await makeProject(role);
    const [assignment, offerResult] = await Promise.all([assign(race), createAt(race._id)]);
    assert.ok((assignment.status === 200 && offerResult.status === 400) || (assignment.status === 409 && offerResult.status === 201));
    const held = await Project.findById(race._id).lean();
    assert.notEqual(Boolean(held.assignedTo), Boolean(await Opportunity.exists({ projectId: race._id })));
    const staffed = await makeProject(role, { assignedTo: applicant._id, status: "in_progress" });
    assert.equal((await createAt(staffed._id)).status, 400);
    const publicRoles = await req("/admin/workspace/job/" + role._id + "/projects", admin);
    assert.equal(publicRoles.projects.find(p => p._id === item.projectId).marketplaceReserved, true);
  });

  await t.test("previous applications are scoped to the user and chosen role, and both forms accept only HTTPS resume links", async () => {
    const first = await makeRole(), second = await makeRole();
    const apply = (role, url) => req("/apply-work", applicant, "POST", { positionId: role._id, resumeUrl: url });
    const lookup = (role, user) => req("/apply-work/me?positionId=" + role._id, user);
    const cleanUrl = "https://example.invalid/resume.pdf";
    for (const url of ["javascript:alert(1)", "http://example.invalid/cv", "https://account:password@example.invalid/"]) {
      assert.equal((await apply(first, url)).status, 400);
      assert.equal((await req("/workspace/apply/" + first._id, applicant, "POST", { resumeUrl: url })).status, 400);
    }
    assert.equal((await apply(first, cleanUrl)).status, 201);
    assert.equal((await lookup(second, applicant))._id, undefined);
    assert.equal((await apply(second, cleanUrl)).status, 201);
    assert.equal((await lookup(first, applicant)).position._id, String(first._id));
    assert.equal((await lookup(second, applicant)).position._id, String(second._id));
    assert.equal((await lookup(first, other))._id, undefined);
    assert.equal((await req("/apply-work/me", applicant)).position._id, String(second._id));
    assert.equal((await req("/apply-work/me?positionId=invalid", applicant)).status, 400);
  });

  await t.test("failure after wallet debit rolls back grant, inventory and debit; retry succeeds", async t => {
    const item = await create({});
    const attempt = terms("rent");
    const before = await readBalance(renter);
    const failure = t.mock.method(Wallet, "create", async () => { throw new Error("Simulated ledger write failure"); });
    assert.equal((await charge(item, renter, "rent", attempt)).status, 500);
    failure.mock.restore();
    assert.equal(await readBalance(renter), before);
    assert.equal(await Grant.countDocuments({ opportunityId: item._id }), 0);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "available");
    assert.equal((await charge(item, renter, "rent", attempt)).status, 201);
  });

  await t.test("decimal-dollar settlement preserves cents across purchases", async () => {
    for (const amount of [0.2, 0.1]) {
      const item = await create({ buyPrice: amount });
      assert.equal((await charge(item, small, "buy", { requestId: randomUUID(), expectedAmount: amount })).status, 201);
    }
    assert.equal(await readBalance(small), 0);
  });

  async function walletFixture(balance, withdrawable) {
    const member = { _id: new mongoose.Types.ObjectId(), role: "user" };
    await User.collection.insertOne({ ...member, email: randomUUID() + "@example.test", walletBalance: balance, withdrawable, pendingWithdrawals: 0 });
    return member;
  }
  const wallet = user => req("/wallet/balance", user);
  const withdraw = (user, amount) => req("/wallet/withdraw", user, "POST", { amount });
  const review = (id, action) => req("/admin/wallet/withdrawals/" + id + "/" + action, admin, "PUT", {});
  await t.test("reserved withdrawals cannot be spent and settlement pays once", async () => {
    const member = await walletFixture(25,25);
    const hold = await withdraw(member,25);
    assert.equal(hold.status, 200);
    const item = await create({});
    assert.equal((await charge(item, member, "buy")).status, 402);
    assert.equal((await wallet(member)).spendable, 0);
    assert.equal((await review(hold.withdrawal._id, "approve")).status, 200);
    const replies = await Promise.all([review(hold.withdrawal._id, "pay"),review(hold.withdrawal._id, "pay")]);
    assert.deepEqual(replies.map(r => r.status).sort(), [200,404]);
    assert.equal((await wallet(member)).balance, 0);
    assert.equal((await wallet(member)).pendingWithdrawals, 0);
    assert.equal(await Wallet.countDocuments({ user: member._id, source: "withdrawal_completed" }), 1);
  });
  await t.test("checkouts consume top-ups first and a competing payout cannot claim spent earnings", async () => {
    const member = await walletFixture(30,20);
    assert.equal((await charge(await create({}), member, "buy")).status, 201);
    assert.equal((await wallet(member)).withdrawable, 5);
    assert.equal((await withdraw(member, 10)).status, 400);
    const rival = await walletFixture(25,25);
    const item = await create({});
    const [spend, hold] = await Promise.all([charge(item,rival,"buy"), withdraw(rival,25)]);
    assert.ok((spend.status === 201 && hold.status === 400) || (spend.status === 402 && hold.status === 200));
    assert.equal((await wallet(rival)).spendable, 0);
  });
  await t.test("the older work withdrawal entry cannot credit already-paid earnings a second time", async () => {
    const member = await walletFixture(25,25);
    await ApplyWork.create({ user: member._id, category: "design", totalEarnings: 25, resumeUrl: "https://example.invalid/cv" });
    const reply = await req("/workspace/withdraw", member, "POST", { amount: 25 });
    assert.equal(reply.status, 200);
    assert.equal((await wallet(member)).balance,25);
    assert.equal((await wallet(member)).pendingWithdrawals,25);
    assert.equal((await req("/workspace/earnings", member)).withdrawable, 0);
    assert.equal((await review(reply.withdrawal._id, "reject")).status,200);
    assert.equal((await wallet(member)).withdrawable,25);
  });
  await t.test("legacy orders and admin debits cannot spend reserved cash or race a new purchase into overdraft", async () => {
    const member = await walletFixture(25,25);
    const service = await Service.collection.insertOne({ title: "Historical fixture", price: 25, currency: "USD" });
    const order = await Order.create({ userId: member._id, serviceId: service.insertedId, quotedAmount: 25, quotedCurrency: "USD" });
    const settle = () => req("/wallet/pay", member, "POST", { orderId: order._id, expectedAmount: 25, expectedCurrency: "USD" });
    const hold = await withdraw(member, 25);
    assert.equal((await settle()).status, 400);
    assert.equal((await req("/admin/wallet/adjust", admin, "POST", { amount: 5, userId: member._id, type: "debit", description: "Synthetic debit" })).status, 400);
    const item = await create({});
    assert.equal((await review(hold.withdrawal._id, "reject")).status, 200);
    const [oldOrder, purchase] = await Promise.all([settle(), charge(item, member, "buy")]);
    assert.ok((oldOrder.status === 200 && purchase.status === 402) || (oldOrder.status === 400 && purchase.status === 201));
    assert.equal(await Wallet.countDocuments({ user: member._id, type: "debit", status: "success" }), 1);
    assert.equal((await wallet(member)).balance, 0);
    assert.equal((await wallet(member)).withdrawable, 0);
  });
  await t.test("withdrawal retries reserve once, mismatched keys conflict, and a failed request write releases the hold", async t => {
    const member = await walletFixture(100,100);
    const requestId = randomUUID();
    const submit = amount => req("/wallet/withdraw", member, "POST", { amount, requestId });
    const failure = t.mock.method(Withdrawal, "create", async () => { throw Error("Simulated receipt failure"); });
    assert.equal((await submit(25)).status, 500);
    failure.mock.restore();
    assert.equal((await wallet(member)).pendingWithdrawals, 0);
    assert.equal(await Wallet.countDocuments({ user: member._id }), 0);
    const replies = await Promise.all([submit(25), submit(25), submit(25)]);
    assert.deepEqual(replies.map(r => r.status), [200,200,200]);
    assert.equal(new Set(replies.map(r => r.withdrawal._id)).size, 1);
    assert.equal((await submit(30)).status, 409);
    const id = replies[0].withdrawal._id;
    assert.equal((await review(id, "approve")).status, 200);
    const brokenLedger = t.mock.method(Wallet, "findOneAndUpdate", async () => { throw Error("Simulated payout write failure"); });
    assert.equal((await review(id, "pay")).status, 500);
    brokenLedger.mock.restore();
    assert.equal((await wallet(member)).balance, 100);
    assert.equal((await wallet(member)).pendingWithdrawals, 25);
    const competed = await Promise.all([review(id, "pay"), review(id, "reject")]);
    assert.deepEqual(competed.map(x => x.status).sort(), [200,404]);
    const end = await wallet(member);
    assert.equal(end.pendingWithdrawals, 0);
    assert.equal(end.balance, competed[0].status === 200 ? 75 : 100);
    assert.equal(end.withdrawable, end.balance);
  });
  await t.test("approved top-ups cannot unlock stale historical withdrawal eligibility or credit twice", async t => {
    const member = await walletFixture(0,25);
    assert.equal((await withdraw(member, 10)).status, 400);
    const topup = await req("/wallet/topup", member, "POST", { amount: 25 });
    assert.equal(topup.status, 200);
    const settlementReference = "QA-" + randomUUID();
    const approve = () => req("/admin/wallet/verify-topup", admin, "POST", { action: "approve", transactionId: topup.transactionId, settlementReference });
    assert.equal((await req("/admin/wallet/verify-topup", admin, "POST", { action: "approve", transactionId: topup.transactionId })).status, 400);
    const failure = t.mock.method(Wallet.prototype, "save", async () => { throw Error("Simulated top-up ledger failure"); });
    assert.equal((await approve()).status, 500);
    failure.mock.restore();
    assert.equal(await readBalance(member), 0);
    assert.deepEqual((await Promise.all([approve(), approve()])).map(r => r.status).sort(), [200,400]);
    const final = await wallet(member);
    assert.equal(final.balance, 25);
    assert.equal(final.spendable, 25);
    assert.equal(final.withdrawable, 0);
    assert.equal((await withdraw(member, 10)).status, 400);
    const duplicate = await req("/wallet/topup", member, "POST", { amount: 10 });
    const reused = await req("/admin/wallet/verify-topup", admin, "POST", { action: "approve", transactionId: duplicate.transactionId, settlementReference: settlementReference.toLowerCase() });
    assert.equal(reused.status, 409);
    assert.equal((await Wallet.findById(duplicate.transactionId)).status, "initiated");
    const verified = await Wallet.findById(topup.transactionId).select("+settlementReference +settlementVerifiedBy");
    assert.equal(verified.settlementReference, settlementReference.toUpperCase());
    assert.equal(String(verified.settlementVerifiedBy), String(admin._id));
    const memberHistory = await req("/wallet/transactions", member);
    const adminHistory = await req("/admin/wallet/user/" + member._id, admin);
    assert.equal(memberHistory.transactions.find(row => row._id === topup.transactionId).settlementReference, undefined);
    assert.equal(adminHistory.transactions.find(row => row._id === topup.transactionId).settlementReference, settlementReference.toUpperCase());
    const item = await create({});
    const request = terms("buy");
    const purchase = await charge(item, member, "buy", request);
    assert.equal(purchase.status, 201);
    assert.equal(purchase.grant.amount, 25);
    assert.equal((await charge(item, member, "buy", request)).replayed, true);
    assert.equal((await access(item, member)).status, 200);
    assert.equal((await charge(item, other, "buy")).status, 409);
    const entries = await Wallet.find({ user: member._id, status: "success" }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(entries.map(row => [row.type, row.amount, row.balanceBefore, row.balanceAfter]),
      [["credit", 25, 0, 25], ["debit", 25, 25, 0]]);
    assert.equal(String(entries[0]._id), topup.transactionId);
    assert.equal(String(entries[1].referenceId), purchase.grant._id);
    assert.equal(await readBalance(member), 0);
  });
});
