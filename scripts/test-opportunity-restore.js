const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { mkdtemp, readFile, writeFile, rm, rmdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { MongoClient, BSON, ObjectId } = require("mongoose").mongo;
const { connectionArgs } = require("./reconcile-wallets");
const { verifyMarketplaceIndexes } = require("./verify-marketplace-indexes");
const runTool = promisify(execFile);

// Restore the offer, project and role, as well as its wallet and grant history,
// into a fresh test database and boot a new process so cached state cannot help.
const bootstrap = `
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.UREMO_FIXTURE_URI);
  const app = require("./src/app");
  await Promise.all(["User", "Opportunity", "OpportunityGrant", "WalletTransaction"].map(name => mongoose.model(name).init()));
  const server = app.listen(0, "127.0.0.1", () => process.send(server.address().port));
  process.on("message", () => server.close(async () => { await mongoose.disconnect(); process.exit(0); }));
})().catch(() => process.exit(1));`;

async function launch(uri, secret, t) {
  const child = spawn(process.execPath, ["-e", bootstrap], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, JWT_SECRET: secret, UREMO_FIXTURE_URI: uri, RESEND_API_KEY: "" },
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill(); });
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(child, "message").then(([value]) => value),
    exited.then(() => { throw Error("Local API exited before startup"); }),
  ]);
  return {
    async stop() { child.send("stop"); await exited; },
    async call(method, route, token, body) {
      const response = await fetch("http://127.0.0.1:" + ready + "/api/opportunities" + route, {
        method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

const port = process.env.UREMO_TEST_MONGO_PORT;
test("a logical marketplace restore into a fresh API process preserves sale, access, wallet and retry history", { skip: !port, timeout: process.env.UREMO_MONGO_TOOLS_DIR ? 240000 : 90000 }, async t => {
  const dbName = () => "uremo_test_" + randomUUID().replaceAll("-", "");
  const sourceName = dbName(), restoredName = dbName();
  const { uri } = connectionArgs(["--db", sourceName, "--port", port]);
  const client = new MongoClient(uri, { directConnection: true });
  await client.connect();
  const from = client.db(sourceName), to = client.db(restoredName);
  t.after(async () => { await from.dropDatabase(); await to.dropDatabase(); await client.close(); });
  const dir = await mkdtemp(path.join(tmpdir(), "uremo-market-restore-"));
  const collections = ["users", "projects", "workpositions", "opportunities", "opportunitygrants", "wallettransactions"];
  t.after(async () => {
    for (const name of collections) await rm(path.join(dir, name + ".bson"), { force: true });
    await rm(path.join(dir, "marketplace.archive.gz"), { force: true });
    await rmdir(dir);
  });
  const secret = randomUUID();
  const buyer = new ObjectId(), rival = new ObjectId(), listing = new ObjectId();
  const projectId = new ObjectId(), roleId = new ObjectId();
  const token = id => jwt.sign({ id: String(id) }, secret);
  const purchase = { requestId: randomUUID(), expectedAmount: 25 };
  const privateText = "Fixture-only handoff " + randomUUID();
  await from.collection("users").insertMany([buyer, rival].map(_id => ({
    _id, name: "Synthetic member", email: String(_id) + "@example.invalid", role: "user", walletBalance: 100,
  })));
  await from.collection("workpositions").insertOne({ _id: roleId, title: "Review", category: "design", active: true });
  await from.collection("projects").insertOne({ _id: projectId, workPositionId: roleId, title: "Design work", status: "open" });
  await from.collection("opportunities").insertOne({ _id: listing, title: "Fixture", description: "Restore QA",
    projectId, projectRoleId: roleId, applyEnabled: false, projectPublishedAt: new Date(),
    category: "design", rightsConfirmed: true, status: "published", buyEnabled: true, buyPrice: 25, currency: "USD",
    deliverable: privateText, soldAt: null, createdAt: new Date() });
  const service = await launch(uri + "/" + sourceName, secret, t);
  const bought = await service.call("POST", "/" + listing + "/buy", token(buyer), purchase);
  assert.equal(bought.status, 201);
  await service.stop(); // Quiesce the source before backing up its documents.
  const toolsDir = process.env.UREMO_MONGO_TOOLS_DIR;
  if (toolsDir) {
    const executable = name => path.resolve(toolsDir, name + (process.platform === "win32" ? ".exe" : ""));
    const archive = "--archive=" + path.join(dir, "marketplace.archive.gz");
    const options = { windowsHide: true, timeout: 45000 };
    await runTool(executable("mongodump"), ["--uri", uri, "--db", sourceName, archive, "--gzip"], options);
    await runTool(executable("mongorestore"), ["--uri", uri, archive, "--gzip", "--stopOnError",
      "--nsInclude", sourceName + ".*", "--nsFrom", sourceName + ".*", "--nsTo", restoredName + ".*"], options);
    const restoredIndexes = await verifyMarketplaceIndexes(to); // Check before the API can create indexes.
    for (const [collection, fields] of [
      ["opportunities", "projectId"],
      ["opportunitygrants", "projectId,type"],
      ["opportunitygrants", "opportunityId,type"],
      ["opportunitygrants", "userId,requestId"],
      ["wallettransactions", "settlementReference"],
    ]) {
      assert.ok(restoredIndexes.some(index => index.collection === collection && Object.keys(index.keys).join(",") === fields),
        `Missing restored ${collection} index on ${fields}`);
    }
    for (const name of collections) assert.equal(await to.collection(name).countDocuments(), await from.collection(name).countDocuments());
    t.diagnostic(`Native archive restored to an empty namespace. Verified ${restoredIndexes.length} marketplace unique indexes including settlementReference before API startup.`);
  } else {
    for (const name of collections) {
      const docs = await from.collection(name).find().toArray();
      assert.ok(docs.length);
      const file = path.join(dir, name + ".bson");
      await writeFile(file, BSON.serialize({ docs }));
      await to.collection(name).insertMany(BSON.deserialize(await readFile(file)).docs);
    }
  }
  const restored = await launch(uri + "/" + restoredName, secret, t);
  const retry = await restored.call("POST", "/" + listing + "/buy", token(buyer), purchase);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.grant._id, bought.data.grant._id);
  assert.equal(retry.data.grant.projectId, String(projectId));
  assert.equal((await restored.call("POST", "/" + listing + "/buy", token(rival), { ...purchase, requestId: randomUUID() })).status, 409);
  assert.equal((await restored.call("GET", "/" + listing + "/access", token(buyer))).data.deliverable, privateText);
  assert.equal((await restored.call("GET", "/" + listing + "/access", token(rival))).status, 403);
  assert.equal((await restored.call("GET", "/" + listing, token(rival))).data.opportunity.availability, "sold");
  assert.equal((await to.collection("users").findOne({ _id: buyer })).walletBalance, 75);
  assert.equal((await to.collection("users").findOne({ _id: rival })).walletBalance, 100);
  assert.equal(await to.collection("wallettransactions").countDocuments({ type: "debit", status: "success" }), 1);
  assert.equal(await to.collection("opportunitygrants").countDocuments(), 1);
  await restored.stop();
});
