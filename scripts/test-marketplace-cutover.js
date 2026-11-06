const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const port = process.env.UREMO_TEST_MONGO_PORT;

test("marketplace cutover preserves history and reports only settled project revenue", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  process.env.JWT_SECRET = randomUUID();
  const database = "uremo_test_" + randomUUID().replaceAll("-", "");
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${database}`, { serverSelectionTimeoutMS: 4000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const User = require("../src/models/User");
  const Order = require("../src/models/Order");
  const Grant = require("../src/models/OpportunityGrant");
  const Wallet = require("../src/models/WalletTransaction");
  const app = require("../src/app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const worker = new mongoose.Types.ObjectId(), editor = new mongoose.Types.ObjectId();
  await User.collection.insertMany([{ _id: worker, email: "worker@example.test", role: "user" }, { _id: editor, email: "editor@example.test", role: "admin" }]);
  async function request(path, method = "GET", who = worker, data) {
    const headers = who ? { Authorization: "Bearer " + jwt.sign({ id: String(who) }, process.env.JWT_SECRET) } : {};
    if (data) headers["Content-Type"] = "application/json";
    return fetch(`http://127.0.0.1:${server.address().port}/api` + path, { headers, method, body: JSON.stringify(data) });
  }
  await t.test("archived markets stay out of public article searches, direct links and new campaigns", async () => {
    const Blog = require("../src/models/Blog");
    const archive = await Blog.create({ title: "Retired sector", slug: "retired", category: "forex_crypto", content: "Earlier product", status: "published" });
    const post = { title: "Guide [first edition]", category: "opportunities", content: "Project scope", status: "published" };
    assert.equal((await request("/admin/blogs", "POST", editor, post)).status, 201);
    assert.equal((await request("/admin/blogs", "POST", editor, { ...post, category: "forex_crypto" })).status, 400);
    const list = await (await request("/blogs?search=%5B", "GET", null)).json();
    assert.equal(list.meta.total, 1);
    assert.deepEqual(list.filters.categories, ["opportunities"]);
    assert.equal((await (await request("/blogs?category=forex_crypto", "GET", null)).json()).meta.total, 0);
    assert.equal((await request("/blogs/retired", "GET", null)).status, 404);
    assert.equal((await request("/admin/blogs/" + archive._id, "GET", editor)).status, 200);
    assert.equal((await request("/admin/blogs/" + archive._id, "PUT", editor, { status: "draft" })).status, 200);
    assert.equal((await request("/admin/campaigns/send", "POST", editor, { title: "Fixture", message: "Fixture", targetTags: ["forex"] })).status, 400);
  });
  await t.test("retired creation endpoints reject requests without reserving orders or debiting wallets", async () => {
    for (const path of ["/orders", "/orders/deal", "/rentals/create", "/rentals/" + worker + "/renew",
      "/payment/checkout", "/payments/checkout", "/wallet/topup/paypal/create", "/service-requests",
      "/admin/services/create", "/jarvisx/write/execute"]) {
      assert.equal((await request(path, "POST", editor)).status, 410, path);
    }
    assert.equal((await request("/services/marketplace", "GET", null)).status, 410);
    assert.equal(await Order.countDocuments(), 0);
    assert.equal(await Wallet.countDocuments(), 0);
    assert.equal((await (await request("/wallet/topup/paypal/available")).json()).available, false);
    await Order.collection.insertOne({ userId: worker, serviceId: new mongoose.Types.ObjectId(), status: "completed" });
    assert.equal((await (await request("/orders/my")).json()).length, 1);
    assert.equal((await request("/rentals/my")).status, 200);
  });
  await t.test("settlement totals are admin-only and exclude wallet funding and historical orders", async () => {
    const route = "/admin/marketplace-revenue";
    assert.equal((await request(route, "GET", null)).status, 401);
    assert.equal((await request(route)).status, 403);
    const rows = [["rent", 1.12], ["rent", 2.21], ["buy", 10.13]].map(([type, amount]) => ({
      opportunityId: new mongoose.Types.ObjectId(), userId: worker, type, amount, currency: "USD", requestId: randomUUID(),
    }));
    await Grant.collection.insertMany(rows);
    await Wallet.collection.insertOne({ user: worker, source: "topup", type: "credit", amount: 100, status: "success" });
    const res = await request(route, "GET", editor);
    assert.match(res.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await res.json(), { currency: "USD", rent: { count: 2, total: 3.33 }, buy: { count: 1, total: 10.13 } });
  });
});
