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
  });
  const failed = execCli(name);
  assert.equal(failed.status, 2);
  assert.deepEqual(JSON.parse(failed.stdout), problem);
  assert.doesNotMatch(failed.stdout + failed.stderr, /private@example|[a-f0-9]{24}/);
  const emptyName = name + "_empty";
  const empty = execCli(emptyName);
  assert.equal(empty.status, 2);
  assert.equal(JSON.parse(empty.stdout).missingCollections.length, 4);
  assert.deepEqual(await client.db(emptyName).listCollections().toArray(), []);
});
