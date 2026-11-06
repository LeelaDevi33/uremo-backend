const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const User = require("../src/models/User");
const Order = require("../src/models/Order");
const Service = require("../src/models/Service");
const Rental = require("../src/models/Rental");
const WalletTransaction = require("../src/models/WalletTransaction");
const flow = require("../src/core/flowEngine");

// Start a disposable, single-node replica set first. Never use hosted data.
const port = process.env.UREMO_TEST_MONGO_PORT;
test("wallet, account and scheduler regression checks", { skip: !port }, async (t) => {
  assert.match(port, /^\d{1,5}$/);
  const dbName = "uremo_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${dbName}`, { serverSelectionTimeoutMS: 4000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  process.env.JWT_SECRET = randomUUID();
  delete process.env.RESEND_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.CRON_SECRET;
  const app = express();
  app.use(express.json());
  app.use("/wallet", require("../src/routes/wallet.routes"));
  app.use("/orders", require("../src/routes/order.routes"));
  app.use("/auth", require("../src/routes/auth.routes"));
  app.use("/public", require("../src/routes/public.routes"));
  app.use("/api/health", require("../src/routes/health.routes"));
  app.use("/cron", require("../src/routes/cron.routes"));
  app.use("/payment", require("../src/routes/payment.routes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const buyer = await User.create({ name: "Buyer", email: "buyer@example.test", password: "TestOnly-1234", walletBalance: 200 });
  const auth = { authorization: "Bearer " + jwt.sign({ id: buyer._id.toString() }, process.env.JWT_SECRET) };
  const service = await Service.collection.insertOne({ title: "Sample", price: 70, currency: "USD", active: true, allowedActions: { buy: true } });
  const serviceId = service.insertedId;
  await Promise.all([WalletTransaction.init(), Order.init(), Rental.init()]);
  async function post(path, body, headers = auth) {
    return fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }
  const order = (fields) => Order.create({ serviceId, userId: buyer._id, ...fields });
  const pay = (id, extra) => post("/wallet/pay", { orderId: String(id), ...extra });
  const balance = async () => (await User.findById(buyer._id)).walletBalance;

  await t.test("pre-cutover quotes survive a catalog edit and eight overlapping requests settle once", async () => {
    const reservation = await post("/orders", { serviceId });
    assert.equal(reservation.status, 410);
    assert.equal(await Order.countDocuments(), 0);
    const { _id: id } = await order({ quotedAmount: 70, quotedCurrency: "USD" });
    await Service.collection.updateOne({ _id: serviceId }, { $set: { price: 95 } });
    let transitions = 0;
    const hook = () => { transitions++; };
    flow.emitter.on("order.in_progress", hook);
    try {
      const replies = await Promise.all(Array.from({ length: 8 }, () => pay(id, { expectedAmount: 70, expectedCurrency: "USD" })));
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 400, 400, 400, 400, 400, 400, 400]);
      assert.equal(transitions, 1);
    } finally { flow.emitter.off("order.in_progress", hook); }
    assert.equal(await balance(), 130);
    const charged = await Order.findById(id);
    assert.equal(charged.settledAmount, 70);
    assert.equal(charged.paymentStatus, "paid");
    assert.equal(charged.paymentMethod, "wallet");
    assert.equal(charged.status, "in_progress");
    assert.ok(charged.paidAt);
    assert.equal(await WalletTransaction.countDocuments({ referenceId: id }), 1);
  });

  await t.test("a ledger failure rolls back the debit and leaves the order payable", async (t) => {
    const item = await order({ quotedAmount: 15, quotedCurrency: "USD" });
    const fail = t.mock.method(WalletTransaction, "create", async () => { throw new Error("Local rollback test"); });
    assert.equal((await pay(item._id)).status, 500);
    assert.equal(await balance(), 130);
    assert.equal((await Order.findById(item._id)).status, "pending");
    assert.equal(await WalletTransaction.countDocuments({ referenceId: item._id }), 0);
    fail.mock.restore();
    assert.equal((await pay(item._id)).status, 200);
    assert.equal(await balance(), 115);
  });

  await t.test("legacy renewals settle at their linked plan price", async () => {
    const renewal = await order({});
    await Rental.collection.insertOne({ order: renewal._id, price: 6, currency: "USD" });
    assert.equal((await pay(renewal._id)).status, 200);
    const debit = await WalletTransaction.findOne({ referenceId: renewal._id });
    assert.equal(debit.amount, 6);
    assert.equal(debit.source, "rental_purchase");
    assert.equal(await balance(), 109);
  });

  await t.test("mismatched quote, missing rental, foreign currency, expiry, ownership and overdraft reject before settlement", async () => {
    const legacy = await order({});
    assert.equal((await pay(legacy._id, { expectedAmount: 70, expectedCurrency: "USD" })).status, 409);
    assert.equal((await pay(legacy._id, { expectedAmount: 95, expectedCurrency: "EUR" })).status, 409);
    const cases = [
      [{ orderType: "rental" }, 400],
      [{ quotedAmount: 15, quotedCurrency: "INR" }, 400],
      [{ expiresAt: new Date(0) }, 410],
      [{ userId: new mongoose.Types.ObjectId() }, 403],
      [{ quotedAmount: 200, quotedCurrency: "USD" }, 400],
    ];
    for (const [fields, expected] of cases) {
      const item = await order(fields);
      assert.equal((await pay(item._id)).status, expected);
      assert.equal(await WalletTransaction.countDocuments({ referenceId: item._id }), 0);
    }
    assert.equal(await balance(), 109);
  });

  await t.test("retired Stripe checkout does not reserve an order", async () => {
    const before = await Order.countDocuments();
    assert.equal((await post("/payment/checkout", { serviceId })).status, 410);
    assert.equal(await Order.countDocuments(), before);
  });

  await t.test("manual verification stores settlement fields from the accepted quote", async () => {
    const item = await order({ status: "waiting_user", quotedAmount: 40, quotedCurrency: "USD" });
    const paid = await flow.transition("order", item._id, "in_progress", {
      actor: "admin", reason: "Payment verified", paymentMethod: "manual",
    });
    assert.equal(paid.settledAmount, 40);
    assert.equal(paid.settledCurrency, "USD");
    assert.equal(paid.paymentStatus, "paid");
    assert.equal(paid.paymentMethod, "manual");
    assert.ok(paid.paidAt);
  });

  await t.test("engagement cron endpoints fail closed when the secret is absent or wrong", async () => {
    for (const path of ["/cron/engagement-batch", "/cron/smart-engagement"]) {
      delete process.env.CRON_SECRET;
      assert.equal((await fetch(url + path)).status, 404);
      process.env.CRON_SECRET = "local-cron-test";
      assert.equal((await fetch(url + path)).status, 401);
      assert.equal((await fetch(url + path + "?secret=incorrect")).status, 401);
    }
  });

  await t.test("registered users count excludes administrators and includes old user records", async () => {
    await User.collection.insertMany([{ email: "admin@example.test", role: "admin" }, { email: "legacy@example.test" }]);
    const response = await fetch(url + "/public/stats");
    assert.equal((await response.json()).stats.totalUsers, 2);
  });

  await t.test("readiness requires a successful database ping; liveness remains available", async (t) => {
    const path = url + "/api/health/ready";
    assert.equal((await fetch(path)).status, 200);
    const failure = t.mock.method(mongoose.connection.db, "command", async () => { throw new Error("Local ping failure"); });
    assert.equal((await fetch(path)).status, 503);
    assert.equal((await fetch(url + "/api/health")).status, 200);
    failure.mock.restore();
    assert.equal((await fetch(path)).status, 200);
  });

  await t.test("a stored bcrypt hash is rejected while a legacy plaintext credential is rehashed", async () => {
    const stored = await User.findById(buyer._id);
    assert.equal((await post("/auth/login", { email: stored.email, password: stored.password }, {})).status, 401);
    await User.collection.insertOne({ name: "Legacy Buyer", email: "migrate@example.test", password: "SampleLegacyPw123", role: "user" });
    assert.equal((await post("/auth/login", { email: "migrate@example.test", password: "SampleLegacyPw123" }, {})).status, 200);
    assert.match((await User.findOne({ email: "migrate@example.test" })).password, /^\$2/);
  });
});
