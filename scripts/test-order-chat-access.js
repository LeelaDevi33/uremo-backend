const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Order = require("../src/models/Order");
const OrderMessage = require("../src/models/OrderMessage");
const User = require("../src/models/User");
const { initSocket } = require("../src/socket");
const { orderChatDenial } = require("../src/services/orderChatPolicy");

test("worker order chat matches REST statuses and owner checks", () => {
  for (const status of ["in_progress", "completed", "waiting_user"]) assert.equal(orderChatDenial({ status, userId: "owner" }, "owner", false), null);
  for (const status of ["pending", "cancelled", "rejected", "unknown"]) assert.equal(orderChatDenial({ status, userId: "owner" }, "owner", false), "CHAT_UNAVAILABLE");
  assert.equal(orderChatDenial({ status: "completed", userId: "owner" }, "other", false), "FORBIDDEN");
  assert.equal(orderChatDenial({ status: "cancelled", userId: "owner" }, "admin", true), null);
});

// Drive Socket.IO over its HTTP polling transport. 42 is an event packet and
// 43 is its acknowledgement; a single poll can also contain queued broadcasts.
async function client(base, claims) {
  const open = await (await fetch(base)).text();
  assert.equal(open[0], "0");
  const url = base + "&sid=" + JSON.parse(open.slice(1)).sid;
  const post = async body => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body });
    assert.equal(res.status, 200);
  };
  const events = [];
  async function until(prefix) {
    for (;;) {
      const packets = (await (await fetch(url, { signal: AbortSignal.timeout(4000) })).text()).split("\x1e");
      let match;
      for (const packet of packets) {
        if (packet.startsWith("42")) events.push(JSON.parse(packet.slice(2)));
        if (packet === "2") await post("3");
        if (packet.startsWith(prefix)) match = packet.slice(prefix.length);
      }
      if (match !== undefined) return JSON.parse(match);
    }
  }
  await post("40" + JSON.stringify({ token: jwt.sign(claims, process.env.JWT_SECRET) }));
  await until("40");
  let sequence = 0;
  return { events, async send(event, data) {
    const id = ++sequence;
    await post("42" + id + JSON.stringify([event, data]));
    return (await until("43" + id))[0];
  } };
}

const port = process.env.UREMO_TEST_MONGO_PORT;
test("joined sockets recheck status, ownership and recipients for every new message", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  const db = "uremo_order_chat_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${db}?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const server = http.createServer(require("../src/app"));
  const io = initSocket(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => io.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port + "/socket.io/?EIO=4&transport=polling";
  const owner = new mongoose.Types.ObjectId();
  const strangerId = new mongoose.Types.ObjectId();
  await User.collection.insertMany([
    { _id: owner, role: "user", email: "worker@example.test" },
    { _id: strangerId, role: "user", email: "other@example.test" },
  ]);
  const order = await Order.collection.insertOne({ userId: owner, status: "cancelled" });
  const orderId = String(order.insertedId);
  const worker = await client(base, { id: String(owner), role: "user" });
  const stranger = await client(base, { id: String(strangerId), role: "user" });
  const adminId = new mongoose.Types.ObjectId();
  const adminClaims = { id: String(adminId), role: "admin" };
  await User.collection.insertOne({ _id: adminId, role: "admin", email: "admin@example.test" });
  const admin = await client(base, adminClaims);
  assert.equal((await worker.send("join:order", { orderId })).error, "CHAT_UNAVAILABLE");
  assert.equal((await stranger.send("join:order", { orderId })).error, "FORBIDDEN");
  assert.ok((await admin.send("admin:join_orders", {})).ok);
  assert.ok((await admin.send("join:order", { orderId })).ok);
  await Order.updateOne({ _id: orderId }, { status: "in_progress" });
  assert.ok((await worker.send("join:order", { orderId })).ok);
  assert.ok((await worker.send("message:send", { orderId, text: "Eligible worker message" })).ok);
  await Order.updateOne({ _id: orderId }, { status: "cancelled" });
  assert.ok((await admin.send("message:send", { orderId, text: "Staff response after closure" })).ok);
  assert.equal((await worker.send("message:send", { orderId, text: "Blocked after closure" })).error, "CHAT_UNAVAILABLE");
  assert.ok(!worker.events.some(([name, payload]) => name === "message:new" && payload.message === "Staff response after closure"));
  assert.equal(await OrderMessage.countDocuments({ orderId }), 2);
  assert.equal((await worker.send("join:order", { orderId })).error, "CHAT_UNAVAILABLE");
  await User.updateOne({ _id: adminId }, { role: "user" });
  await Order.updateOne({ _id: orderId }, { status: "in_progress" });
  assert.ok((await worker.send("join:order", { orderId })).ok);
  assert.ok((await worker.send("message:send", { orderId, text: "Private after demotion" })).ok);
  assert.equal((await admin.send("admin:join_orders", {})).error, "FORBIDDEN");
  assert.ok(!admin.events.some(([, payload]) => payload.message === "Private after demotion" ||
    payload.message?.message === "Private after demotion"));
  assert.equal((await admin.send("join:order", { orderId })).error, "FORBIDDEN");
  const token = jwt.sign(adminClaims, process.env.JWT_SECRET);
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/orders/" + orderId + "/messages", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(response.status, 403);
});
