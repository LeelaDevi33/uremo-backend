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
  await t.test("ticket replies return the persisted state and closed tickets require explicit reopening", async () => {
    const Ticket = require("../src/models/Ticket");
    for (const [initial, expected] of [["open", "in_progress"], ["closed", "closed"], ["waiting_user", "waiting_user"]]) {
      const ticket = await Ticket.create({ subject: "Support fixture", user: worker, status: initial });
      const response = await request("/admin/tickets/" + ticket.id + "/reply", "POST", editor, { message: "Fixture reply" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, expected);
      const saved = await Ticket.findById(ticket.id);
      assert.equal(saved.status, expected);
      assert.ok(saved.firstResponseAt);
    }
  });
  await t.test("records top-up decisions when the admin JWT contains only a user ID", async () => {
    const Log = require("../src/models/AdminAuditLog");
    const { logAdminAction } = require("../src/services/adminAudit.service");
    for (const action of ["topup_approve", "topup_reject"]) {
      await logAdminAction({ adminId: editor, action, entityType: "wallet_transaction", entityId: String(worker) });
      assert.ok(await Log.exists({ adminId: editor, action, entityType: "wallet_transaction", adminEmail: "editor@example.test" }));
    }
  });
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
  await t.test("admin receipt pages and queue counts use settled records and do not leak private handoffs", async () => {
    const Opportunity = require("../src/models/Opportunity");
    const WalletWithdrawal = require("../src/models/WithdrawalRequest");
    const AffiliateWithdrawal = require("../src/models/AffiliateWithdrawal");
    const start = new Date(), end = new Date(start.getTime() + 3600000);
    await Opportunity.collection.insertMany([
      { status: "published", rightsConfirmed: true }, { status: "published", rightsConfirmed: true, soldAt: start },
      { status: "draft" }, { status: "published", rightsConfirmed: false },
    ]);
    await Grant.collection.insertMany(Array.from({length: 26}, () => ({
      requestId: randomUUID(), opportunityId: new mongoose.Types.ObjectId(), userId: worker,
      type: "rent", title: "Receipt fixture", amount: 2, currency: "USD", startsAt: start, endsAt: end,
      deliverable: "Private handoff", balanceAfter: 19,
    })));
    await WalletWithdrawal.collection.insertMany([{status: "pending"}, {status: "paid"}]);
    await AffiliateWithdrawal.collection.insertMany([{status: "pending"}, {status: "pending"}]);
    for (const route of ["/admin/operations-summary", "/admin/marketplace-receipts"]) {
      assert.equal((await request(route, "GET", null)).status, 401);
      assert.equal((await request(route)).status, 403);
    }
    const summary = await (await request("/admin/operations-summary", "GET", editor)).json();
    assert.deepEqual(summary.marketplace, { published: 1, drafts: 1, activeRentals: 26, sales: 1 });
    assert.equal(summary.badges.walletWithdrawals, 1);
    assert.equal(summary.badges.referralWithdrawals, 2);
    const page = await (await request("/admin/marketplace-receipts?type=rent", "GET", editor)).json();
    assert.equal(page.receipts.length, 25);
    assert.ok(page.nextCursor);
    assert.ok(page.receipts.every(row => row.type === "rent" && !("balanceAfter" in row) && !("deliverable" in row)));
    const second = await (await request("/admin/marketplace-receipts?type=rent&before=" + page.nextCursor, "GET", editor)).json();
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...page.receipts, ...second.receipts].map(row => row._id)).size, 28);
    assert.equal((await request("/admin/marketplace-receipts?before=invalid", "GET", editor)).status, 400);
  });
  await t.test("both former gateway editors can disable an existing method but cannot create or reopen one", async () => {
    const Method = require("../src/models/PaymentMethod");
    const method = await Method.create({type:"bank", name:"Fixture", details:"Local only"});
    for (const path of ["/admin/payments", "/payment-methods/admin"]) {
      assert.equal((await request(path + "/" + method.id, "PUT", worker, { active: false })).status, 403);
      assert.equal((await request(path, "POST", editor, {type:"crypto"})).status, 410);
      assert.equal((await request(path + "/" + method.id, "PUT", editor, { active: true })).status, 410);
      assert.equal((await request(path + "/" + method.id, "PUT", editor, { active: false })).status, 200);
    }
    assert.equal((await Method.findById(method.id)).active, false);
    assert.equal(await Method.countDocuments(), 1);
  });
});
