const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Rental = require("../src/models/Rental");
const Order = require("../src/models/Order");
const Worker = require("../src/models/WorkerApplication");
const { canReadRentalAccess } = require("../src/utils/rentalAccess");
const getRentals = require("../src/jarvisx/tools/getRentals");

const port = process.env.UREMO_TEST_MONGO_PORT;
test("customer rental access and legacy application administration", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  delete process.env.RESEND_API_KEY;
  const uri = "mongodb://127.0.0.1:" + port + "/uremo_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const id = () => new mongoose.Types.ObjectId();
  const owner = id(), stranger = id(), admin = id(), serviceId = id();
  await User.collection.insertMany([
    { _id: owner, name: "Owner", email: "owner@example.test", role: "user" },
    { _id: stranger, name: "Other", email: "other@example.test", role: "user" },
    { _id: admin, name: "Admin", email: "admin@example.test", role: "admin" },
  ]);
  const token = (userId, role) => jwt.sign({ id: String(userId), role }, process.env.JWT_SECRET);
  const ownerToken = token(owner, "user"), adminToken = token(admin, "admin");
  const staleAdminToken = token(stranger, "admin"), otherToken = token(stranger, "user");

  async function request(path, credential, method = "GET", body) {
    const headers = { "content-type": "application/json" };
    if (credential) headers.authorization = "Bearer " + credential;
    const response = await fetch("http://127.0.0.1:" + server.address().port + path,
      { method, headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  await t.test("legacy admin list and status update require a current database admin role", async () => {
    const appId = id();
    await Worker.collection.insertOne({ _id: appId, userId: owner, status: "pending", email: "qa@example.test" });
    for (const [credential, expected] of [[null, 401], [ownerToken, 403], [staleAdminToken, 403], [adminToken, 200]]) {
      const list = await request("/api/workers/admin", credential);
      assert.equal(list.status, expected);
      const update = await request("/api/workers/admin/" + appId, credential, "PUT", { status: "approved" });
      assert.equal(update.status, expected);
      const saved = await Worker.collection.findOne({ _id: appId });
      assert.equal(saved.status, expected === 200 ? "approved" : "pending");
    }
  });

  const moment = Date.now(), past = new Date(moment - 3600000), future = new Date(moment + 3600000);
  const cases = [
    ["active paid", {}, { paymentStatus: "paid" }, true],
    ["pending", { status: "pending" }, { paymentStatus: "paid" }, false],
    ["label expired", { status: "expired" }, { paymentStatus: "paid" }, false],
    ["elapsed without cron", { endDate: past }, { paymentStatus: "paid" }, false],
    ["future successor", { startDate: future, previousRental: id() }, { paymentStatus: "paid" }, false],
    ["cancelled rental", { status: "cancelled" }, { paymentStatus: "paid" }, false],
    ["recorded revocation", { cancelledAt: past }, { paymentStatus: "paid" }, false],
    ["cancelled order", {}, { status: "cancelled", paymentStatus: "paid" }, false],
    ["explicit unpaid", {}, { paymentStatus: "unpaid", paidAt: past }, false],
    ["refunded", {}, { paymentStatus: "refunded", paidAt: past }, false],
    ["no historical payment evidence", {}, {}, false],
    ["legacy verified", {}, { payment: { verifiedAt: past } }, true],
    ["legacy paid date", {}, { paidAt: past }, true],
    ["paid old term after renewal request", { status: "renewed", statusLog: [{ status: "active", at: past }] }, { paidAt: past }, true],
    ["renewal without prior activation", { status: "renewed" }, { paidAt: past }, false],
    ["foreign payment link", {}, { userId: stranger, paymentStatus: "paid" }, false],
    ["order links elsewhere", {}, { rentalId: id(), paymentStatus: "paid" }, false],
  ];
  const rows = [];
  for (const [label, rentalFields, orderFields, allowed] of cases) {
    const rentalId = id(), orderId = id(), details = "synthetic-access-" + rentalId;
    await Order.collection.insertOne({ _id: orderId, userId: owner, serviceId, rentalId, status: "in_progress", ...orderFields });
    await Rental.collection.insertOne({ _id: rentalId, user: owner, service: serviceId, order: orderId,
      status: "active", startDate: past, endDate: future, accessDetails: details, notes: "internal-only", ...rentalFields });
    rows.push({ label, rentalId, orderId, details, allowed });
  }

  const list = await request("/api/rentals/my", ownerToken);
  assert.equal(list.status, 200);
  assert.match(list.headers.get("cache-control"), /no-store/);
  const assistantList = await getRentals({ limit: 20 }, { userId: owner });
  for (const row of rows) {
    await t.test(row.label + " agrees across customer reads", async () => {
      const detail = await request("/api/rentals/" + row.rentalId, ownerToken);
      assert.equal(detail.status, 200);
      const listed = list.body.rentals.find(r => r._id === String(row.rentalId));
      for (const rental of [listed, detail.body.rental]) {
        assert.equal(rental.accessDetails, row.allowed ? row.details : undefined);
        assert.equal(rental.notes, undefined);
        assert.equal(rental.isActive, row.allowed);
      }
      const assistantRental = assistantList.data.find(r => String(r.rentalId) === String(row.rentalId));
      assert.equal(assistantRental.hasAccess, row.allowed);
      const order = await request("/api/orders/" + row.orderId, ownerToken);
      if (row.label === "foreign payment link") assert.equal(order.status, 403);
      else {
        assert.equal(order.status, 200);
        assert.equal(order.body.rentalId?.accessDetails, row.allowed ? row.details : undefined);
      }
    });
  }

  await t.test("foreign and demoted users cannot read order/rental details; current admin can manage", async () => {
    const [valid, pending] = rows;
    assert.equal((await request("/api/rentals/" + valid.rentalId, otherToken)).status, 404);
    assert.equal((await request("/api/orders/" + valid.orderId, otherToken)).status, 403);
    assert.equal((await request("/api/orders/" + valid.orderId, staleAdminToken)).status, 403);
    const adminOrder = await request("/api/orders/" + pending.orderId, adminToken);
    assert.equal(adminOrder.status, 200);
    assert.equal(adminOrder.body.rentalId.accessDetails, pending.details);
    const rentals = await request("/api/admin/rentals", adminToken);
    assert.equal(rentals.body.rentals.find(r => r._id === String(pending.rentalId)).accessDetails, pending.details);
    const myOrders = await request("/api/orders/my", ownerToken);
    assert.equal(myOrders.status, 200);
    assert.doesNotMatch(JSON.stringify(myOrders.body), /synthetic-access-/);
  });

  await t.test("time window includes start and excludes exact end", () => {
    const order = { _id: "test-order", userId: "owner", paymentStatus: "paid" };
    const rental = { _id: "test-rental", user: "owner", order: "test-order", status: "active", startDate: past, endDate: future };
    assert.equal(canReadRentalAccess(rental, order, "owner", past.getTime()), true);
    assert.equal(canReadRentalAccess(rental, order, "owner", future.getTime()), false);
  });

  await t.test("a customer order pointing to another customer's rental reveals no rental", async () => {
    const rentalId = id(), orderId = id();
    await Order.collection.insertOne({ _id: orderId, userId: owner, serviceId, rentalId, status: "in_progress", paymentStatus: "paid" });
    await Rental.collection.insertOne({ _id: rentalId, user: stranger, order: orderId, service: serviceId,
      status: "active", startDate: past, endDate: future, accessDetails: "foreign-synthetic" });
    const order = await request("/api/orders/" + orderId, ownerToken);
    assert.equal(order.status, 200);
    assert.equal(order.body.rentalId, null);
    assert.equal((await request("/api/rentals/" + rentalId, ownerToken)).status, 404);
  });
});
