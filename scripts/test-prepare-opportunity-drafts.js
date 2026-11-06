const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const mongoose = require("mongoose");
const Opportunity = require("../src/models/Opportunity");
const WorkPosition = require("../src/models/WorkPosition");
const Service = require("../src/models/Service");
const { createRoleApplication, unavailablePositionIds } = require("../src/services/opportunityApplications");

const run = promisify(execFile);
const cli = path.join(__dirname, "prepare-opportunity-drafts.js");
const port = process.env.UREMO_TEST_MONGO_PORT;

test("reject broad selections, bad IDs and remote targets before connecting", async () => {
  for (const args of [
    ["--db", "example"], ["--db", "example", "--role", "all"],
    ["--db", "example", "--uri", "mongodb://elsewhere/db"],
    ["--db", "admin", "--role", "a00000000000000000000001"],
  ]) await assert.rejects(run(process.execPath, [cli, ...args]), error => error.code === 1 && !error.stderr.includes("mongodb://"));
});

test("reviewed role cutover through the real CLI on a unique loopback replica database", { skip: !port }, async t => {
  assert.match(port, /^\d{1,5}$/);
  const db = "uremo_cutover_test_" + randomUUID().replaceAll("-", "");
  const file = path.join(os.tmpdir(), db + ".json");
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${db}?directConnection=true`, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await fs.rm(file, { force: true });
  });
  const invoke = async (...args) => {
    const { stdout } = await run(process.execPath, [cli, "--db", db, "--port", port, ...args]);
    assert.ok(!stdout.includes("private-fixture-marker"));
    return JSON.parse(stdout);
  };
  const role = (title, category, extra = {}) => WorkPosition.create({ title, category, active: true, ...extra });
  const good = await role("Prototype review", "design", { description: "private-fixture-marker", adminNotes: "private-fixture-marker" });
  const mapped = await role("Field interviews", "Old project role");
  const inactive = await role("Inactive project", "design", { active: false });
  const finance = await role("Legacy product", "forex_accounts");
  const foreign = await Service.collection.insertOne({ category: "banks_gateways_wallets", subcategory: "banks", slug: "old-finance" });
  const fromFinance = await role("Operations review", "operations", { serviceId: foreign.insertedId });
  const unselected = await role("Unselected project", "research");
  const missing = new mongoose.Types.ObjectId();
  const map = Object.fromEntries([good, mapped, inactive, finance, fromFinance].map(r => [String(r._id), "research"]));
  map[String(missing)] = "design";
  await fs.writeFile(file, JSON.stringify(map), { flag: "wx" });
  const indexesBefore = await mongoose.connection.db.listCollections().toArray();
  const plan = await invoke("--map", file);
  const byRole = results => Object.fromEntries(results.map(row => [row.roleId, row.result]));
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(byRole(plan.results), {
    [good._id]: "would_create", [mapped._id]: "would_create", [inactive._id]: "inactive_or_missing",
    [finance._id]: "excluded_legacy_product", [fromFinance._id]: "excluded_legacy_product", [missing]: "inactive_or_missing",
  });
  assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), indexesBefore);
  assert.equal(await Opportunity.countDocuments(), 0);
  assert.equal((await invoke("--role", String(mapped._id))).results[0].result, "needs_category_mapping");
  assert.equal((await invoke("--role", String(good._id))).results[0].category, "design");

  const concurrent = await Promise.all([invoke("--map", file, "--write"), invoke("--map", file, "--write")]);
  assert.equal(concurrent.flatMap(r => r.results).filter(r => r.result === "created").length, 2);
  assert.equal(concurrent.flatMap(r => r.results).filter(r => r.result === "already_linked").length, 2);
  assert.equal(await Opportunity.countDocuments(), 2);
  assert.equal(await Opportunity.countDocuments({ workPositionId: unselected._id }), 0);
  assert.equal(await Opportunity.countDocuments({ status: "published" }), 0);
  const draft = await Opportunity.findOne({ workPositionId: good._id }).select("+preserveRoleUntilPublished +deliverable").lean();
  assert.equal(draft.title, good.title);
  assert.equal(draft.category, "research");
  assert.equal(draft.status, "draft");
  assert.equal(draft.applyEnabled, true);
  assert.equal(draft.preserveRoleUntilPublished, true);
  assert.equal(draft.rightsConfirmed, false);
  assert.equal(draft.buyEnabled || draft.rentEnabled, false);
  assert.equal(draft.rentPrice + draft.buyPrice, 0);
  assert.equal(draft.description + draft.deliverable, "");
  assert.equal((await unavailablePositionIds()).map(String).includes(String(good._id)), false);
  await createRoleApplication({ user: new mongoose.Types.ObjectId(), position: good._id });
  await Opportunity.updateOne({ _id: draft._id }, { title: "Edited by reviewer" });
  const replay = await invoke("--role", String(good._id), "--role", String(good._id), "--write");
  assert.deepEqual(replay.results, [{ roleId: String(good._id), result: "already_linked" }]);
  assert.equal((await Opportunity.findById(draft._id)).title, "Edited by reviewer");
});
