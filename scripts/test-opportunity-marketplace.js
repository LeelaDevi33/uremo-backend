const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Opportunity = require("../src/models/Opportunity");
const Grant = require("../src/models/OpportunityGrant");
const Wallet = require("../src/models/WalletTransaction");
const User = require("../src/models/User");
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
  const offer = { title: "Synthetic design brief", description: "Source assets and handoff for a test project",
    category: "design", status: "published", rightsConfirmed: true, rentEnabled: true, rentalDays: 3,
    rentPrice: 4.25, buyEnabled: true, buyPrice: 25, deliverable: "PRIVATE-" + randomUUID() };
  const terms = type => type === "rent" ? { requestId: randomUUID(), expectedAmount: 4.25, expectedRentalDays: 3 } :
    { requestId: randomUUID(), expectedAmount: 25 };
  async function create(extra) {
    const result = await req(adminApi, admin, "POST", { ...offer, ...extra });
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.opportunity;
  }
  const charge = (item, user, mode, body = terms(mode)) => req(api + "/" + item._id + "/" + mode, user, "POST", body);
  const access = (item, user) => req(api + "/" + item._id + "/access", user);
  const makeRole = async () => Role.create({ title: "QA role", category: "Design", active: true, serviceId: new mongoose.Types.ObjectId() });

  await t.test("admin drafts, private/public field boundaries, category, terms and publication checks", async () => {
    assert.equal((await req(adminApi)).status, 401);
    assert.equal((await req(adminApi, buyer)).status, 403);
    const draft = await req(adminApi, admin, "POST", { status: "draft" });
    assert.equal(draft.status, 201);
    assert.equal((await req(api + "/" + draft.opportunity._id)).status, 404);
    for (const change of [{ rightsConfirmed: false }, { category: "forex_crypto" }, { rentPrice: 1.001 },
         { rentalDays: 0 }, { deliverable: "" }, { workPositionId: new mongoose.Types.ObjectId(), applyEnabled: true },
         { soldAt: new Date() }]) {
      const invalid = await req(adminApi, admin, "POST", { ...offer, ...change });
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
    const fresh = await req(adminApi + "/" + item._id, admin, "PATCH", { description: "Updated project scope" });
    const before = await readBalance(buyer);
    const outdated = await charge(item, buyer, "buy", { ...terms("buy"), expectedRevision: item.revision });
    assert.equal(outdated.status, 409);
    assert.equal(await readBalance(buyer), before);
    const paid = await charge(item, buyer, "buy", { ...terms("buy"), expectedRevision: fresh.opportunity.revision });
    assert.equal(paid.status, 201);
    await req(adminApi + "/" + item._id, admin, "PATCH", { status: "archived" });
    assert.equal((await access(item, buyer)).grant.projectScope, "Updated project scope");
  });
  await t.test("insufficient wallet, foreign role, stale price and inactive option never charge", async () => {
    const item = await create({});
    const before = await readBalance(small);
    assert.equal((await charge(item, null, "buy")).status, 401);
    assert.equal((await charge(item, small, "buy")).status, 402);
    assert.equal((await charge(item, buyer, "rent", { ...terms("rent"), expectedRentalDays: 2 })).status, 409);
    assert.equal((await charge(item, buyer, "buy", { ...terms("buy"), expectedAmount: 10 })).status, 409);
    assert.equal(await readBalance(small), before);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "available");
    assert.equal(await Grant.countDocuments({ opportunityId: item._id }), 0);
    await req(adminApi + "/" + item._id, admin, "PATCH", { buyEnabled: false });
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
    assert.equal((await charge(item, other, "buy")).status, 409);
    assert.equal((await charge(item, other, "rent")).status, 409);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "sold");
    assert.equal((await req(api)).opportunities.some(r => r._id === item._id), false);
    assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { status: "published" })).status, 409);
    assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { status: "archived" })).status, 200);
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

  await t.test("both application endpoints reject unpublished and archived work; duplicate concurrent applications share one admission", async () => {
    const role = await makeRole();
    const item = await create({ workPositionId: role._id, applyEnabled: true, status: "draft" });
    const legacy = { positionId: String(role._id), resumeUrl: "https://example.test/resume" };
    for (const state of ["draft", "published", "archived"]) {
      const changed = await req(adminApi + "/" + item._id, admin, "PATCH", { status: state });
      assert.equal(changed.status, 200);
      const work = "/workspace/apply/" + role._id;
      if (state === "published") {
        const pair = await Promise.all([req(work, applicant, "POST", {}), req("/apply-work", applicant, "POST", legacy)]);
        assert.deepEqual(pair.map(r => r.status).sort(), [201,409]);
      } else {
        assert.equal((await req(work, other, "POST", {})).status, 409);
        assert.equal((await req("/apply-work", other, "POST", legacy)).status, 409);
        assert.equal((await req("/work-positions/by-service/" + role.serviceId)).status, 404);
      }
    }
    assert.equal(await ApplyWork.countDocuments({ position: role._id }), 1);
  });

  await t.test("rental snapshots, time-bound access, free applications and closure on exclusive sale", async () => {
    const role = await makeRole();
    const item = await create({ workPositionId: String(role._id), applyEnabled: true });
    assert.equal((await req(adminApi, admin, "POST", { ...offer, workPositionId: role._id })).status, 409);
    assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { workPositionId: null })).status, 409);
    const rented = await charge(item, renter, "rent");
    assert.equal(rented.status, 201, JSON.stringify(rented));
    assert.equal(new Date(rented.grant.endsAt) - new Date(rented.grant.startsAt), 3 * 86400000);
    assert.equal((await charge(item, buyer, "buy")).status, 409);
    assert.equal((await charge(item, other, "rent")).status, 409);
    const edit = await req(adminApi + "/" + item._id, admin, "PATCH", { deliverable: "REPLACEMENT-PRIVATE" });
    assert.equal(edit.status, 200);
    assert.equal((await access(item, renter)).deliverable, offer.deliverable);
    const before = await readBalance(applicant);
    const application = await req("/workspace/apply/" + role._id, applicant, "POST", {});
    assert.equal(application.status, 201, JSON.stringify(application));
    assert.equal(await readBalance(applicant), before);
    assert.equal((await access(item, applicant)).status, 403);
    const legacyApplication = { positionId: String(role._id), resumeUrl: "https://example.test/resume" };
    assert.equal((await req("/apply-work", applicant, "POST", legacyApplication)).status, 409);
    // Advance only synthetic fixture dates to the past, without relying on a timer or a cron job.
    const expired = new Date(Date.now() - 1);
    await Grant.updateOne({ _id: rented.grant._id }, { $set: { endsAt: expired, startsAt: new Date(Date.now()-86400000) } });
    await Opportunity.updateOne({ _id: item._id }, { $set: { rentedUntil: expired } });
    assert.equal((await access(item, renter)).status, 403);
    const expiredGrant = (await req(api + "/mine", renter)).grants.find(g => g._id === rented.grant._id);
    assert.equal(expiredGrant.active, false);
    assert.equal((await req(api + "/" + item._id)).opportunity.availability, "available");
    assert.equal((await charge(item, buyer, "buy")).status, 201);
    assert.equal((await access(item, buyer)).deliverable, "REPLACEMENT-PRIVATE");
    assert.equal((await req("/workspace/apply/" + role._id, other, "POST", {})).status, 409);
    assert.equal((await req("/apply-work", other, "POST", legacyApplication)).status, 409);
    assert.equal((await req("/work-positions/by-service/" + role.serviceId)).status, 404);
    const positions = await req("/work-positions");
    assert.equal(Object.values(positions).some(x => x?._id === String(role._id)), false);
    assert.equal(await ApplyWork.countDocuments({ position: role._id }), 1);
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

  await t.test("a migration-only draft preserves an existing open role until the admin archives or publishes it", async () => {
    for (const transition of ["archived", "published"]) {
      const role = await makeRole();
      const item = await Opportunity.create({ ...offer, workPositionId: role._id, status: "draft", applyEnabled: true,
        preserveRoleUntilPublished: true });
      const legacy = "/work-positions/by-service/" + role.serviceId;
      assert.equal((await req(legacy)).status, 200);
      assert.equal((await req(api + "/" + item._id)).status, 404);
      assert.equal((await req("/workspace/apply/" + role._id, applicant, "POST", {})).status, 201);
      assert.equal((await req("/apply-work", renter, "POST", { positionId: role._id, resumeUrl: "https://example.invalid/cv" })).status, 201);
      assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { status: transition })).status, 200);
      assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { status: "draft" })).status, 200);
      assert.equal((await req(legacy)).status, 404);
      assert.equal((await req("/workspace/apply/" + role._id, other, "POST", {})).status, 409);
      assert.equal((await req(adminApi + "/" + item._id, admin, "PATCH", { preserveRoleUntilPublished: true })).status, 400);
    }
  });

  await t.test("a deactivated role hides Apply on list and detail while administrators can see the configured role", async () => {
    const role = await makeRole();
    const item = await create({ applyEnabled: true, workPositionId: role._id });
    const detail = () => req(api + "/" + item._id);
    assert.equal((await detail()).opportunity.applyEnabled, true);
    await Role.updateOne({ _id: role._id }, { $set: { active: false } });
    assert.equal((await detail()).opportunity.applyEnabled, false);
    assert.equal((await req(api)).opportunities.find(x => x._id === item._id).applyEnabled, false);
    const configured = (await req(adminApi + "/" + item._id, admin)).opportunity;
    assert.equal(configured.applyEnabled, true);
    assert.equal(configured.workPositionId, String(role._id));
    assert.equal((await req("/workspace/apply/" + role._id, applicant, "POST", {})).status, 400);
  });

  await t.test("an application racing a sale cannot commit after that sale", async t => {
    const role = await makeRole();
    const item = await create({ applyEnabled: true, workPositionId: role._id });
    let signalSaleWrite, releaseCommit;
    const wroteSale = new Promise(resolve => { signalSaleWrite = resolve; });
    const hold = new Promise(resolve => { releaseCommit = resolve; });
    const originalSave = Opportunity.prototype.save;
    t.mock.method(Opportunity.prototype, "save", async function (...args) {
      const saved = await originalSave.apply(this, args);
      if (this.soldAt && String(this._id) === item._id) {
        signalSaleWrite();
        await hold;
      }
      return saved;
    });
    const purchase = charge(item, buyer, "buy");
    await Promise.race([wroteSale, purchase.then(() => { throw Error("Sale did not reach inventory write"); })]);
    const admission = req("/workspace/apply/" + role._id, applicant, "POST", {});
    releaseCommit();
    const [sale, application] = await Promise.all([purchase, admission]);
    assert.equal(sale.status, 201);
    assert.equal(application.status, 409);
    assert.equal(await ApplyWork.countDocuments({ position: role._id }), 0);
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
    const approve = () => req("/admin/wallet/verify-topup", admin, "POST", { action: "approve", transactionId: topup.transactionId });
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
  });
});
