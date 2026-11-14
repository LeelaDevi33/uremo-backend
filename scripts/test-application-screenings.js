const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Role = require("../src/models/WorkPosition");
const Application = require("../src/models/ApplyWork");
const Screening = require("../src/models/Screening");
const Proof = require("../src/models/ProofOfWork");
const Project = require("../src/models/Project");
const { runAutoValidation } = require("../src/utils/screeningEngine");

test("an unconfigured multiple-choice answer cannot award a point for an empty answer", () => {
  const result = runAutoValidation({ questions: [{ type: "single", points: 1 }], evaluationMode: "auto" }, [""]);
  assert.equal(result.autoScore, 0);
  assert.equal(result.autoPass, false);
});

const port = process.env.UREMO_TEST_MONGO_PORT;
test("applications only qualify on their unlocked, assigned screenings", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  delete process.env.RESEND_API_KEY;
  await mongoose.connect("mongodb://127.0.0.1:" + port + "/uremo_screening_test_" + randomUUID().replaceAll("-", ""));
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const user = new mongoose.Types.ObjectId(), admin = new mongoose.Types.ObjectId();
  await User.collection.insertMany([{ _id: user, role: "user", name: "Worker", email: "worker@example.test" },
    { _id: admin, role: "admin", name: "Editor", email: "editor@example.test" }]);
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function call(path, body, who = user, method = body ? "POST" : "GET") {
    const token = jwt.sign({ id: String(who), role: who === admin ? "admin" : "user" }, process.env.JWT_SECRET);
    const response = await fetch(base + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  const screening = (title, evaluationMode) => Screening.create({ title, category: "writing", evaluationMode,
    questions: [{ question: "Choose yes", options: ["yes", "no"], correctAnswer: "yes" }] });
  const [one, two, foreign] = await Promise.all([screening("Copy", "auto"), screening("Manual", "manual"), screening("Unassigned", "auto")]);
  const role = await Role.create({ title: "Editor", category: "writing", hasScreening: true, screeningId: one._id,
    screeningIds: [one._id, two._id] });
  const record = await Application.create({ user, position: role._id, status: "approved", workerStatus: "screening_available" });
  const route = id => "/workspace/screening/" + id;
  const submit = (id, extra = {}) => call(route(id) + "/submit", { positionId: record._id, answers: ["yes"], ...extra });
  const review = (id, action) => call("/admin/workspace/screening-submissions/" + record._id + "/review", { screeningId: id, action }, admin);
  const getStatus = async () => (await Application.findById(record._id).lean()).workerStatus;
  await t.test("only approved active applications receive private training from the profile", async () => {
    const material = { title: "Private training", type: "pdf", url: "https://example.test/private-training.pdf" };
    const privateRole = await Role.create({ title: "Private role", category: "testing", trainingMaterials: [material], screeningIds: [one._id] });
    const pending = await Application.create({ user, position: privateRole._id, status: "pending", workerStatus: "applied" });
    const profile = async () => (await call("/workspace/profile")).body.applications.find(row => row._id === String(pending._id));
    for (const [status, workerStatus, allowed] of [
      ["pending","applied",false], ["approved","screening_unlocked",true], ["approved","suspended",false], ["rejected","inactive",false],
    ]) {
      await Application.updateOne({ _id: pending._id }, { status, workerStatus });
      const row = await profile();
      assert.equal(JSON.stringify(row).includes(material.url), allowed);
      assert.equal(row.requiredScreenings.length, allowed ? 1 : 0);
    }
    await Application.deleteOne({ _id: pending._id });
  });
  await t.test("legacy unlocked training, active flags, assignment and private answers", async () => {
    assert.equal((await call("/workspace/application/" + record._id + "/mark-training-viewed", {}, user, "PUT")).status, 200);
    assert.equal((await call(route(foreign._id))).status, 403);
    assert.equal((await submit(foreign._id)).status, 403);
    await Screening.updateOne({ _id: two._id }, { active: false });
    assert.equal((await call(route(two._id))).status, 404);
    assert.equal((await submit(two._id)).status, 404);
    const profile = (await call("/workspace/profile")).body.applications[0];
    assert.strictEqual(profile.requiredScreenings.find(s => s._id === String(two._id)).active, false);
    assert.deepEqual((await call("/workspace/screenings")).body.screenings.map(s => s.title), ["Copy"]);
    await Screening.updateOne({ _id: two._id }, { active: true });
    const available = await call(route(one._id) + "?positionId=" + record._id);
    assert.equal(available.status, 200);
    assert.equal(available.body.screening.questions[0].correctAnswer, undefined);
    assert.equal((await submit(one._id, { answers: {} })).status, 400);
    const otherRole = await Role.create({ title: "Reviewer", category: "writing", hasScreening: true, screeningId: one._id });
    const other = await Application.create({ user, position: otherRole._id, status: "approved", workerStatus: "screening_unlocked" });
    assert.equal((await call(route(one._id))).status, 409);
    assert.equal((await call(route(one._id) + "/submit", { answers: ["yes"] })).status, 409);
    assert.equal((await call(route(one._id) + "?positionId=" + record._id)).status, 200);
    await Application.deleteOne({ _id: other._id });
  });
  await t.test("concurrent submissions use one attempt; manual review cannot undo a suspension", async () => {
    const results = await Promise.all([submit(one._id), submit(one._id)]);
    assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
    assert.equal(await getStatus(), "screening_unlocked");
    assert.equal((await Application.findById(record._id)).attemptCount, 1);
    assert.equal((await submit(one._id)).status, 403);
    assert.equal((await submit(two._id)).body.submissionStatus, "pending_review");
    await Application.updateOne({ _id: record._id }, { workerStatus: "suspended" });
    assert.equal((await review(two._id, "approve")).status, 409);
    assert.equal(await getStatus(), "suspended");
    await Application.updateOne({ _id: record._id }, { workerStatus: "test_submitted" });
    assert.equal((await review(two._id, "approve")).body.workerStatus, "ready_to_work");
    assert.equal((await review(two._id, "approve")).status, 404);
  });
  await t.test("historical pending results cannot count toward another assessment's automatic pass", async () => {
    await Application.updateOne({ _id: record._id }, { workerStatus: "screening_unlocked", attemptCount: 0,
      screeningsCompleted: [{ screeningId: two._id, passed: null, submissionStatus: "pending_review" }] });
    assert.equal((await submit(one._id)).body.newStatus, "screening_unlocked");
    await Application.updateOne({ _id: record._id }, { status: "rejected", workerStatus: "screening_unlocked" });
    assert.equal((await call(route(two._id))).status, 403);
  });
  await t.test("staff proof pages filter by account across pages and older account links open the worker", async () => {
    const other = new mongoose.Types.ObjectId();
    await Proof.collection.insertMany([{ workerId: user, status: "approved" }, { workerId: other, status: "pending" }]);
    const result = await call("/admin/proofs?workerId=" + user + "&limit=1", null, admin);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.stats, { approved: 1, pending: 0, rejected: 0 });
    assert.equal(result.body.total, 1);
    assert.equal(result.body.proofs[0].workerId.name, "Worker");
    assert.equal((await call("/admin/proofs?workerId=malformed", null, admin)).status, 400);
    assert.equal((await call("/admin/proofs?workerId=" + user)).status, 403);
    assert.equal((await call("/admin/workspace/worker/" + user, null, admin)).body.worker._id, String(record._id));
    await Project.collection.insertOne({ title: "Unassigned private project", assignedTo: null });
    const orphan = await Application.create({ user: other, status: "pending" });
    const missing = await call("/admin/workspace/worker/" + orphan._id, null, admin);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.worker.projects.length, 0);
  });
  await t.test("a worker with two roles can submit and have proof approved for the assigned role", async () => {
    const secondRole = await Role.create({ title: "Fact checker", category: "writing" });
    const project = await Project.create({ title: "Verify sources", description: "Check the newsletter", category: "writing",
      status: "assigned", assignedTo: user, workPositionId: secondRole._id, payRate: 0 });
    await Application.create({ user, position: secondRole._id, status: "approved", workerStatus: "assigned", currentProject: project._id });
    const proof = await call("/workspace/project/" + project._id + "/proof", { submissionText: "Verified all five named sources." });
    assert.equal(proof.status, 201, JSON.stringify(proof));
    assert.equal(proof.body.proof.jobRoleId, String(secondRole._id));
    const reviewed = await call("/admin/proofs/" + proof.body.proof._id + "/approve", {}, admin, "PUT");
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  });
  await t.test("dataset assignments expose only active tasks and pay each approved submission exactly once", async t => {
    const Dataset = require("../src/models/Dataset"), Task = require("../src/models/DatasetTask");
    const Submission = require("../src/models/RlhfSubmission"), Wallet = require("../src/models/WalletTransaction");
    await Submission.init();
    const dataset = await Dataset.create({ name: "Writing fixture", datasetType: "generation", isActive: true });
    const task = await Task.create({ datasetId: dataset._id, prompt: "Summarize this example.", correctAnswer: "Private rubric" });
    const otherTask = await Task.create({ datasetId: new mongoose.Types.ObjectId(), prompt: "Other dataset task" });
    const project = await Project.create({ title: "Task review", category: "writing", status: "assigned",
      projectType: "rlhf_dataset", assignedTo: user, workPositionId: role._id, datasetId: dataset._id, payRate: 0, rewardPerTask: 5.25 });
    const url = "/workspace/project/" + project._id;
    assert.equal((await call(url + "/rlhf-tasks", null, admin)).status, 403);
    const listed = await call(url + "/rlhf-tasks");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.tasks.map(row => row._id), [String(task._id)]);
    assert.ok(!JSON.stringify(listed.body).includes(task.correctAnswer));
    const submit = taskId => call(url + "/rlhf-submit", { taskId, answerPayload: { response: "Fixture answer" } });
    assert.equal((await submit(otherTask._id)).status, 404);
    const row = (await submit(task._id)).body.submission;
    assert.equal(row.workerId, String(user));
    const review = changes => call("/admin/datasets/rlhf/submissions/" + row._id + "/review",
      { action: "approved", finalScore: 0, ...changes }, admin);
    const before = await User.findById(user);
    assert.equal((await review({ rewardOverride: -1 })).status, 400);
    const failLedger = t.mock.method(Wallet, "create", async () => { throw Error("Synthetic payment failure"); });
    assert.equal((await review()).status, 500);
    failLedger.mock.restore();
    assert.equal((await Submission.findById(row._id)).reviewStatus, "pending_review");
    assert.equal((await User.findById(user)).walletBalance, before.walletBalance);
    const decisions = await Promise.all([review(), review()]);
    assert.deepEqual(decisions.map(r => r.status).sort(), [200, 409]);
    const approved = decisions.find(r => r.status === 200).body.submission;
    assert.equal(approved.reviewedBy, String(admin));
    assert.equal(approved.rewardAmount, 5.25);
    const paid = await User.findById(user);
    for (const field of ["walletBalance", "lifetimeEarnings", "withdrawable"]) assert.equal(paid[field], (before[field] || 0) + 5.25);
    assert.equal(await Wallet.countDocuments({ referenceId: row._id, user, source: "earning", type: "credit", amount: 5.25 }), 1);
    await Project.updateOne({ _id: project._id }, { status: "cancelled" });
    assert.equal((await submit(task._id)).status, 409);
  });

  await t.test("legacy reset commands cannot erase operational balances", async () => {
    await User.updateOne({ _id: user }, { walletBalance: 31, affiliateBalance: 9 });
    for (const [operation, confirm] of [["wallets", "RESET_ALL_WALLETS"], ["affiliate", "RESET_ALL_AFFILIATE"], ["all-test-data", "RESET_ALL_TEST_DATA"]]) {
      assert.equal((await call("/admin/reset/" + operation, { confirm }, admin)).status, 410);
      assert.equal((await call("/admin/reset/" + operation, { confirm })).status, 403);
    }
    const account = await User.findById(user);
    assert.equal(account.walletBalance, 31);
    assert.equal(account.affiliateBalance, 9);
  });
});
