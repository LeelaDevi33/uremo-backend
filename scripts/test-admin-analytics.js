const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

test("admin analytics separates net projects, deposits and verified legacy settlements", { skip: !process.env.UREMO_TEST_MONGO_PORT }, async t => {
  const port = process.env.UREMO_TEST_MONGO_PORT;
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  await mongoose.connect(`mongodb://127.0.0.1:${port}/uremo_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const db = mongoose.connection.db;
  const id = () => new mongoose.Types.ObjectId();
  const admin = id(), buyer = id(), serviceId = id();
  const today = new Date(), older = new Date("2018-05-01T12:00:00Z");
  await db.collection("users").insertMany([{ _id: admin, email: "admin@example.invalid", role: "admin" }, { _id: buyer, email: "buyer@example.invalid", role: "user" }]);
  const grants = [["buy", 10.11], ["rent", 2.22], ["buy", 99]].map(([type, amount]) => ({
    _id: id(), userId: buyer, opportunityId: id(), type, currency: "USD", amount, requestId: randomUUID(),
  }));
  grants[2].refundedAt = today;
  await db.collection("opportunitygrants").insertMany(grants);
  await db.collection("services").insertOne({ _id: serviceId, price: 9999, currency: "USD" });
  const legacy = [
    { status: "in_progress", paymentStatus: "paid", settledAmount: 12.34, settledCurrency: "USD", paidAt: today },
    { status: "completed", paymentStatus: "paid", settledAmount: 80, settledCurrency: "INR", paidAt: today },
    { status: "completed", quotedCurrency: "USD" }, // A single wallet debit below supplies the historical amount and date.
    { status: "completed", quotedAmount: 999, quotedCurrency: "USD" }, // A quote is not a settlement.
    { status: "pending", paymentStatus: "unpaid" },
    { status: "completed", quotedCurrency: "USD" }, // Two debit candidates cannot establish a single settlement.
    { status: "completed" }, // Currency was not captured by the previous checkout.
  ].map(row => ({ _id: id(), userId: buyer, serviceId, createdAt: older, ...row }));
  await db.collection("orders").insertMany(legacy);
  const debit = (referenceId, amount) => ({ user: buyer, source: "service_purchase", type: "debit", amount, status: "success", referenceId, createdAt: today });
  await db.collection("wallettransactions").insertMany([
    debit(legacy[0]._id, 12.34), debit(legacy[2]._id, 4.56), debit(legacy[5]._id, 8), debit(legacy[5]._id, 8), debit(legacy[6]._id, 9),
    debit(grants[0]._id, 10.11), { ...debit(grants[2]._id, 99), type: "credit", source: "refund" },
    ...["success", "pending", "failed", "initiated", "paid_unverified"].map(status => ({
      user: buyer, source: "topup", type: "credit", status, amount: 13.37,
    })),
  ]);
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (route, user) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/analytics/${route}`,
    { headers: user ? { Authorization: "Bearer " + jwt.sign({ id: String(user) }, process.env.JWT_SECRET) } : {} });
  assert.equal((await get("dashboard")).status, 401);
  assert.equal((await get("dashboard", buyer)).status, 403);
  const dashboard = await get("dashboard", admin);
  assert.equal(dashboard.status, 200);
  const { stats } = await dashboard.json();
  assert.deepEqual(stats.marketplace, { currency: "USD", buy: { count: 1, total: 10.11 }, rent: { count: 1, total: 2.22 } });
  assert.deepEqual(stats.deposits, { currency: "USD", count: 1, total: 13.37 });
  assert.equal(stats.totalWalletVolume, 112.37);
  assert.deepEqual(stats.legacyByCurrency, [{ currency: "INR", count: 1, total: 80 }, { currency: "USD", count: 2, total: 16.9 }]);
  assert.equal(stats.legacyUnknown, 3);
  const chart = await (await get("charts?days=1", admin)).json();
  assert.deepEqual(chart.revenuePerDay, [{ _id: today.toISOString().slice(0, 10), count: 2, total: 16.9 }]);
  assert.equal((await get("charts?days=-1", admin)).status, 400);
});
