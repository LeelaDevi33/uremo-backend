const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Wallet = require("../src/models/WalletTransaction");
const User = require("../src/models/User");
const paypal = require("../src/config/paypal");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

test("wallet funding methods and provider-confirmed settlement on mounted routes", { skip: !process.env.UREMO_TEST_MONGO_PORT }, async t => {
  const port = process.env.UREMO_TEST_MONGO_PORT;
  assert.match(port, /^\d{1,5}$/);
  const database = "uremo_test_" + randomUUID().replaceAll("-", "");
  process.env.JWT_SECRET = randomUUID();
  for (const key of Object.keys(process.env)) if (key.startsWith("PAYPAL_")) delete process.env[key];
  Object.assign(process.env, { UREMO_ENVIRONMENT: "staging", FRONTEND_URL: "http://localhost:3137" });
  await mongoose.connect("mongodb://127.0.0.1:" + port + "/" + database);
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await Wallet.init();
  const users = ["admin", "user", "user"].map((role, i) => ({ _id: new mongoose.Types.ObjectId(), role, email: i + "@example.test", walletBalance: 0 }));
  await User.collection.insertMany(users);
  const [admin, worker, other] = users;
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  const request = async (path, user, method = "GET", data, headers = {}) => {
    const options = { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) };
    if (user) options.headers.authorization = "Bearer " + jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET);
    const result = await fetch(base + path, options);
    return { status: result.status, body: await result.json() };
  };
  const methods = "/admin/payments/funding", topup = "/wallet/topup", gateway = topup + "/paypal";
  const setGateway = (user, enabled, updatedAt) => request(methods + "/paypal", user, "PATCH", { enabled, updatedAt });
  const balance = async user => (await User.findById(user._id)).walletBalance;

  await t.test("only active manual methods accept transfers and concurrent submissions create one pending receipt", async () => {
    const draft = { name: "Synthetic transfer", details: "Local demonstration", active: false };
    assert.equal((await request(methods, worker, "POST", draft)).status, 403);
    const created = (await request(methods, admin, "POST", draft)).body.method;
    const transfer = { methodId: created._id, paymentReference: "receipt-123", amount: 12.34 };
    assert.deepEqual((await request("/wallet/funding-methods", worker)).body.methods, []);
    assert.equal((await request(topup, worker, "POST", transfer)).status, 409);
    const edit = { active: true, updatedAt: created.updatedAt };
    assert.equal((await request(methods + "/" + created._id, admin, "PATCH", edit)).status, 200);
    assert.equal((await request(methods + "/" + created._id, admin, "PATCH", edit)).status, 409);
    const attempts = await Promise.all([request(topup, worker, "POST", transfer), request(topup, worker, "POST", transfer)]);
    assert.deepEqual(attempts.map(entry => entry.status).sort(), [200, 409]);
    const transactionId = attempts.find(entry => entry.status === 200).body.transactionId;
    assert.equal(await balance(worker), 0);
    assert.equal((await request("/admin/wallet/verify-topup", admin, "POST", { transactionId, action: "approve", settlementReference: "different-ref" })).status, 400);
    assert.equal((await request("/admin/wallet/verify-topup", admin, "POST", { transactionId, action: "approve", settlementReference: transfer.paymentReference })).status, 200);
    assert.equal(await balance(worker), 12.34);
  });

  await t.test("gateway requires a complete sandbox configuration and explicit admin activation", async () => {
    const body = { amount: 25 };
    assert.equal((await request(gateway + "/create", worker, "POST", body)).status, 503);
    assert.equal((await setGateway(admin, true, null)).status, 409);
    Object.assign(process.env, { PAYPAL_MODE: "sandbox", PAYPAL_MERCHANT_ID: "TESTMERCHANT", PAYPAL_CLIENT_ID: "TESTCLIENT",
      PAYPAL_CLIENT_SECRET: randomUUID(), PAYPAL_WEBHOOK_ID: "TESTWEBHOOK" });
    process.env.PAYPAL_MODE = "live";
    assert.equal(paypal.status().configured, false);
    process.env.PAYPAL_MODE = "sandbox";
    assert.equal((await request(gateway + "/create", worker, "POST", body)).status, 503);
    assert.equal((await setGateway(worker, true, null)).status, 403);
    const enabled = await setGateway(admin, true, null);
    assert.equal(enabled.body.paypal.available, true);
    assert.equal((await setGateway(admin, false, null)).status, 409);
    assert.equal((await request("/wallet/funding-methods", worker)).body.paypal.available, true);
  });

  await t.test("only a verified merchant-bound capture can credit once under webhook and browser races", async t => {
    const orderId = "TESTORDER42", captureId = "TESTCAPTURE42";
    let order;
    const hook = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: orderId } } } };
    const headers = { "paypal-transmission-sig": "verified-at-test-provider" };
    t.mock.method(paypal, "authorize", async () => "test");
    t.mock.method(paypal, "create", async (_token, input, key) => {
      assert.ok(key.startsWith("create-"));
      order = { id: orderId, intent: input.intent, status: "APPROVED", purchase_units: input.purchase_units };
      return { id: orderId, links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=" + orderId }] };
    });
    t.mock.method(paypal, "read", async () => structuredClone(order));
    t.mock.method(paypal, "capture", async (_token, id, key) => {
      assert.equal(id, orderId);
      assert.ok(key.startsWith("capture-"));
      order.status = "COMPLETED";
      order.purchase_units[0].payments = { captures: [{ id: captureId, status: "COMPLETED", final_capture: true, amount: { currency_code: "USD", value: "25.00" } }] };
    });
    t.mock.method(paypal, "verify", async (_token, headers) => headers["paypal-transmission-sig"] === "verified-at-test-provider");
    const created = await request(gateway + "/create", worker, "POST", { amount: 25 });
    assert.equal(created.status, 200);
    assert.equal(order.purchase_units[0].custom_id, created.body.transactionId);
    const confirm = user => request(gateway + "/confirm", user, "POST", { paypalOrderId: orderId });
    assert.equal((await confirm(other)).status, 404);
    assert.equal((await request(gateway + "/webhook", null, "POST", hook)).status, 401);
    assert.equal((await request("/admin/wallet/verify-topup", admin, "POST", { transactionId: created.body.transactionId, action: "approve", settlementReference: "FAKE" })).status, 409);
    const updated = (await request(methods, admin)).body.paypal.updatedAt;
    assert.equal((await setGateway(admin, false, updated)).body.paypal.available, false);
    assert.equal((await request(gateway + "/create", worker, "POST", { amount: 25 })).status, 503);
    const unit = order.purchase_units[0];
    for (const [obj, field, invalid] of [[unit.payee, "merchant_id", "OTHER"], [unit.amount, "currency_code", "EUR"], [unit.amount, "value", "26.00"], [unit, "custom_id", "other"]]) {
      const previous = obj[field]; obj[field] = invalid;
      assert.equal((await confirm(worker)).status, 409);
      obj[field] = previous;
    }
    assert.equal(await balance(worker), 12.34);
    const responses = await Promise.all([confirm(worker), request(gateway + "/webhook", null, "POST", hook, headers)]);
    assert.deepEqual(responses.map(r => r.status), [200, 200]);
    assert.equal((await confirm(worker)).body.alreadyProcessed, true);
    assert.equal((await request(gateway + "/webhook", null, "POST", hook, headers)).status, 200);
    assert.equal(await balance(worker), 37.34);
    const receipts = await Wallet.find({ provider: "paypal", status: "success" }).select("+settlementReference");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].settlementReference, "PAYPAL:" + captureId);
    assert.equal(receipts[0].balanceBefore, 12.34);
    assert.equal(receipts[0].balanceAfter, 37.34);
  });
});

test("server preserves conflicting historical manual requests and refuses to open checkout without its indexes", { skip: !process.env.UREMO_TEST_MONGO_PORT }, async t => {
  const port = process.env.UREMO_TEST_MONGO_PORT;
  assert.match(port, /^\d{1,5}$/);
  const uri = "mongodb://127.0.0.1:" + port + "/uremo_test_" + randomUUID().replaceAll("-", "");
  const connection = new mongoose.mongo.MongoClient(uri);
  await connection.connect();
  t.after(async () => { await connection.db().dropDatabase(); await connection.close(); });
  const rows = connection.db().collection("wallettransactions");
  const request = { user: new mongoose.Types.ObjectId(), methodId: new mongoose.Types.ObjectId(), provider: "manual", paymentReference: "TEST-PRIVATE-REF" };
  await rows.insertMany([{ ...request, status: "initiated" }, { ...request, status: "pending" }]);
  const env = { ...process.env, MONGO_URI: uri, JWT_SECRET: randomUUID(), PORT: "0", UREMO_ENVIRONMENT: "test" };
  await assert.rejects(promisify(execFile)(process.execPath, [path.resolve(__dirname, "../src/server.js")], { env, timeout: 20000 }), err => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Marketplace indexes could not be initialized/);
    assert.doesNotMatch(err.stderr, /TEST-PRIVATE-REF/);
    assert.doesNotMatch(err.stdout, /UREMO backend running on port/);
    return true;
  });
  assert.equal(await rows.countDocuments(request), 2);
});
