const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { MongoClient, ObjectId } = require("mongoose").mongo;
const { inspect, connectionArgs } = require("./reconcile-wallets");
const cli = require.resolve("./reconcile-wallets");

test("reconciliation only accepts a loopback database and explicit valid port", () => {
  for (const argv of [[], ["--db", "admin"], ["--db", "mongodb://remote/records"], ["--db", "restore", "--uri", "mongodb://remote"],
    ["--db", "restore", "--port", "65536"], ["--db", "restore", "--write"]]) assert.throws(() => connectionArgs(argv));
  assert.deepEqual(connectionArgs(["--db", "restored_copy", "--port", "27018"]), { uri: "mongodb://127.0.0.1:27018", name: "restored_copy" });
});

const port = process.env.UREMO_TEST_MONGO_PORT;
test("read-only reconciliation differentiates healthy, inconsistent and incomplete restored copies", { skip: !port }, async t => {
  const name = "uremo_test_" + randomUUID().replaceAll("-", "");
  const { uri } = connectionArgs(["--db", name, "--port", port]);
  const client = new MongoClient(uri, { directConnection: true, monitorCommands: true, serverSelectionTimeoutMS: 4000 });
  await client.connect();
  const db = client.db(name);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  const user = new ObjectId(), project = new ObjectId();
  await db.collection("users").insertOne({ _id: user, walletBalance: 50, pendingWithdrawals: 10, withdrawable: 15, email: "private@example.invalid" });
  await db.collection("withdrawalrequests").insertOne({ userId: user, status: "approved", amount: 10 });
  await db.collection("projects").insertOne({ _id: project, assignedTo: user, earningsCredited: 25 });
  const goodLedger = { referenceId: project, user, amount: 25, source: "earning", status: "success", type: "credit" };
  await db.collection("wallettransactions").insertOne({ ...goodLedger });
  const allowedCommands = new Set(["listCollections", "find", "getMore", "killCursors"]);
  async function auditedRead() {
    const ops = [];
    const capture = event => ops.push(event.commandName);
    client.on("commandStarted", capture);
    let report;
    try { report = await inspect(db); } finally { client.off("commandStarted", capture); }
    assert.ok(ops.length >= 5);
    assert.ok(ops.every(op => allowedCommands.has(op)), JSON.stringify(ops));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(String(user) + "|private@example"));
    return report;
  }
  const execCli = dbName => spawnSync(process.execPath, [cli, "--db", dbName, "--port", port], { encoding: "utf8", timeout: 25000 });
  assert.equal((await auditedRead()).result, "pass");
  assert.equal(execCli(name).status, 0);

  const broken = new ObjectId();
  await db.collection("users").insertMany([
    { _id: broken, walletBalance: 8, pendingWithdrawals: 12, withdrawable: 2 },
    { walletBalance: -5, withdrawable: 0.111 },
  ]);
  await db.collection("withdrawalrequests").insertMany([
    { userId: broken, status: "pending", amount: 10 }, { userId: new ObjectId(), status: "approved", amount: 1.111 },
    { userId: broken, status: "rejected", amount: 1000 },
  ]);
  await db.collection("projects").insertOne({ assignedTo: broken, earningsCredited: "bad" });
  await db.collection("wallettransactions").insertOne({ ...goodLedger, user: broken, amount: 12 });
  const problem = await auditedRead();
  assert.equal(problem.result, "review");
  assert.deepEqual(problem.findings, {
    invalidWalletAmounts: 1, negativeWalletAmounts: 1, reservedExceedsTotal: 2, withdrawableExceedsSpendable: 1,
    reservationTotalsMismatch: 1, invalidOpenWithdrawalAmounts: 1, orphanOpenWithdrawals: 1, invalidProjectCredits: 1,
    creditedProjectsWithoutLedger: 1, creditedProjectsWithDuplicateLedger: 1, projectLedgerMismatch: 1,
    accessReceiptDebitCount: 0, accessReceiptRefundCount: 0, accessReceiptLedgerMismatch: 0, orphanAccessTransactions: 0,
  });
  const failed = execCli(name);
  assert.equal(failed.status, 2);
  assert.deepEqual(JSON.parse(failed.stdout), problem);
  assert.doesNotMatch(failed.stdout + failed.stderr, /private@example|[a-f0-9]{24}/);

  const grants = db.collection("opportunitygrants");
  const transactions = db.collection("wallettransactions");
  const sale = new ObjectId(), rental = new ObjectId(), refundId = new ObjectId();
  const receipt = { userId: user, currency: "USD", amount: 12.25 };
  const debit = { user, amount: 12.25, source: "service_purchase", status: "success", type: "debit" };
  await grants.insertMany([
    { ...receipt, _id: sale, type: "buy", refundedAt: new Date(), refundTransactionId: refundId },
    { ...receipt, _id: rental, type: "rent" },
  ]);
  await transactions.insertMany([
    { ...debit, referenceId: sale, withdrawablePortion: 5.25 },
    { ...debit, referenceId: sale, _id: refundId, type: "credit", source: "refund", withdrawablePortion: 5.25 },
    { ...debit, referenceId: rental, source: "rental_purchase" },
    { ...debit, referenceId: new ObjectId(), description: "Legacy service" },
  ]);
  const healthyReceipts = await auditedRead();
  assert.equal(healthyReceipts.scanned.accessReceipts, 2);
  assert.deepEqual(healthyReceipts.findings, problem.findings);

  await transactions.updateOne({ _id: refundId }, { $set: { withdrawablePortion: 2.25 } });
  assert.equal((await auditedRead()).findings.accessReceiptLedgerMismatch, 1);
  await transactions.updateOne({ _id: refundId }, { $set: { withdrawablePortion: 5.25, amount: 3 } });
  assert.equal((await auditedRead()).findings.accessReceiptLedgerMismatch, 1);
  await transactions.updateOne({ _id: refundId }, { $set: { amount: 12.25, user: new ObjectId() } });
  assert.equal((await auditedRead()).findings.accessReceiptLedgerMismatch, 1);
  await transactions.updateOne({ _id: refundId }, { $set: { user } });
  await grants.updateOne({ _id: sale }, { $set: { refundTransactionId: new ObjectId() } });
  assert.equal((await auditedRead()).findings.accessReceiptLedgerMismatch, 1);
  await grants.updateOne({ _id: sale }, { $set: { refundTransactionId: refundId } });
  await transactions.deleteOne({ _id: refundId });
  await transactions.insertOne({ ...debit, referenceId: sale, withdrawablePortion: 5.25 });
  await transactions.deleteOne({ referenceId: rental });
  await transactions.insertOne({ ...debit, referenceId: new ObjectId(), description: "Exclusive opportunity purchase: Example" });
  const corruptReceipts = await auditedRead();
  assert.equal(corruptReceipts.findings.accessReceiptDebitCount, 2);
  assert.equal(corruptReceipts.findings.accessReceiptRefundCount, 1);
  assert.equal(corruptReceipts.findings.orphanAccessTransactions, 1);
  await db.createCollection("opportunities");
  await grants.drop();
  assert.deepEqual((await auditedRead()).missingCollections, ["opportunitygrants"]);
  const emptyName = name + "_empty";
  const empty = execCli(emptyName);
  assert.equal(empty.status, 2);
  assert.equal(JSON.parse(empty.stdout).missingCollections.length, 4);
  assert.deepEqual(await client.db(emptyName).listCollections().toArray(), []);
});
