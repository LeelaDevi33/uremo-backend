const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");

test("project alerts reach qualified workers in that specialization once and respect job alert preferences", {
  skip: !process.env.UREMO_TEST_MONGO_PORT,
}, async t => {
  const { uri, name } = require("./reconcile-wallets").connectionArgs([
    "--port", process.env.UREMO_TEST_MONGO_PORT, "--db", "uremo_test_" + randomUUID().replaceAll("-", ""),
  ]);
  await mongoose.connect(uri + "/" + name);
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const db = mongoose.connection.db;
  const { notifyReadyWorkers } = require("../src/services/smartEngagement.service");
  const id = () => new mongoose.Types.ObjectId();
  const role = id(), anotherRole = id(), assessment = id(), project = id();
  await db.collection("workpositions").insertMany([
    { _id: role, title: "Research", active: true, hasScreening: true, screeningId: assessment },
    { _id: anotherRole, title: "Design", active: true },
  ]);
  await db.collection("projects").insertOne({ _id: project, title: "Synthetic research project", workPositionId: role, status: "open" });
  const members = Array.from({ length: 6 }, id);
  await db.collection("users").insertMany(members.map((_id, index) => ({
    _id, email: _id + "@example.invalid", emailPreferences: { productUpdates: false, jobAlerts: index !== 2 },
  })));
  const approved = { position: role, status: "approved", workerStatus: "ready_to_work", screeningsCompleted: [{ screeningId: assessment, passed: true }] };
  await db.collection("applyworks").insertMany([
    { ...approved, user: members[0] }, { ...approved, user: members[0] },
    { ...approved, user: members[1], position: anotherRole }, { ...approved, user: members[2] },
    { ...approved, user: members[3], screeningsCompleted: [] }, { ...approved, user: members[4], status: "pending" },
    { ...approved, user: members[5], currentProject: id() },
  ]);
  const result = await notifyReadyWorkers("Unsaved draft title", "design", String(project));
  assert.deepEqual(result, { notified: 1, emailed: 0 });
  const notice = await db.collection("notifications").findOne();
  assert.equal(String(notice.user), String(members[0]));
  assert.match(notice.message, /Synthetic research project/);
  assert.doesNotMatch(notice.message, /Unsaved/);
  await db.collection("projects").updateOne({ _id: project }, { $set: { status: "assigned", assignedTo: members[0] } });
  assert.deepEqual(await notifyReadyWorkers("", "", String(project)), { notified: 0, emailed: 0 });
  assert.equal(await db.collection("notifications").countDocuments(), 1);
});
