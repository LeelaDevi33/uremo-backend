const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Withdrawal = require("../src/models/AffiliateWithdrawal");
const Commission = require("../src/models/AffiliateTransaction");
require("../src/models/Order"); // History populates the original order.

const port = process.env.UREMO_TEST_MONGO_PORT;
test("historical affiliate settlement through authenticated local routes", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  const secret = randomUUID();
  process.env.JWT_SECRET = secret;
  delete process.env.RESEND_API_KEY;
  const db = "uremo_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect("mongodb://127.0.0.1:" + port + "/" + db, { serverSelectionTimeoutMS: 4000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const id = () => new mongoose.Types.ObjectId();
  const owner = id(), admin = id(), stranger = id();
  await User.collection.insertMany([
    { _id: owner, role: "user", name: "Historical fixture", affiliateBalance: 50, totalAffiliateEarned: 70 },
    { _id: admin, role: "admin", name: "QA admin" }, { _id: stranger, role: "user", name: "Other fixture" },
  ].map(row => ({ ...row, email: String(row._id) + "@example.invalid" })));
  await Commission.create({ user: owner, referredUser: stranger, order: id(), orderAmount: 700, commission: 70, status: "approved" });
  await Withdrawal.create({ user: owner, amount: 20, status: "paid", paymentMethod: "bank", paymentDetails: "Old synthetic record" });
  const app = express();
  app.use(express.json());
  app.use("/referrals", require("../src/routes/affiliate.routes"));
  app.use("/admin", require("../src/routes/admin.affiliate.routes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function req(route, person, method = "GET", body) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + route, {
      method, headers: { "content-type": "application/json", authorization: "Bearer " + jwt.sign({ id: String(person), role: person === admin ? "admin" : "user" }, secret) },
      body: JSON.stringify(body),
    });
    return { code: response.status, ...await response.json() };
  }
  const claim = (paymentMethod = "bank") => req("/referrals/withdraw", owner, "POST", { amount: 25.25, paymentMethod, paymentDetails: "Synthetic destination" });
  const balance = async () => (await User.findById(owner).select("affiliateBalance")).affiliateBalance;
  await t.test("JWT account reads the actual ledger and historical paid total", async () => {
    const { summary, commissions } = await req("/referrals/commissions", owner);
    assert.equal(summary.withdrawnAmount, 20);
    assert.equal(summary.availableBalance, 50);
    assert.equal(commissions.length, 1);
    assert.equal((await req("/referrals/stats", owner)).stats.transactionsByStatus.approved.total, 70);
    assert.equal((await req("/referrals/commissions", stranger)).commissions.length, 0);
  });
  await t.test("invalid method and a failed write preserve all previously earned funds", async t => {
    assert.equal((await claim("unknown")).code, 400);
    const failure = t.mock.method(Withdrawal, "create", async () => { throw Error("Simulated failure"); });
    assert.equal((await claim()).code, 500);
    failure.mock.restore();
    assert.equal(await balance(), 50);
    assert.equal(await Withdrawal.countDocuments({ user: owner, status: "pending" }), 0);
  });
  await t.test("competing requests reserve once; simultaneous decisions either pay or refund once", async () => {
    const pair = await Promise.all([claim("paypal"), claim("crypto")]);
    assert.deepEqual(pair.map(x => x.code).sort(), [200,400]);
    const withdrawal = pair.find(x => x.code === 200).withdrawal;
    assert.equal(await balance(), 24.75);
    assert.equal((await req("/referrals/commissions", owner)).summary.pendingWithdrawal, 25.25);
    const decide = action => req("/admin/withdrawals/" + withdrawal._id + "/" + action, admin, "PUT", { adminNotes: "Synthetic decision" });
    const decisions = await Promise.all([decide("approve"), decide("reject"), decide("reject")]);
    assert.deepEqual(decisions.map(x => x.code).sort(), [200,400,400]);
    const paid = decisions[0].code === 200;
    assert.equal(await balance(), paid ? 24.75 : 50);
    const final = (await req("/referrals/commissions", owner)).summary;
    assert.equal(final.pendingWithdrawal, 0);
    assert.equal(final.withdrawnAmount, paid ? 45.25 : 20);
    assert.equal((await req("/referrals/withdrawals", owner)).total, 2);
  });
});
