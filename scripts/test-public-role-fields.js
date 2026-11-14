const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const WorkPosition = require("../src/models/WorkPosition");
const Service = require("../src/models/Service");
const User = require("../src/models/User");
const jwt = require("jsonwebtoken");

const port = process.env.UREMO_TEST_MONGO_PORT;
test("public role and marketplace responses exclude internal notes and project resources", { skip: !port }, async (t) => {
  assert.match(port, /^\d{1,5}$/);
  const database = "uremo_test_" + randomUUID().replaceAll("-", "");
  process.env.JWT_SECRET = randomUUID();
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${database}`, { serverSelectionTimeoutMS: 4000 });
  t.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const serviceId = new mongoose.Types.ObjectId();
  const positionId = new mongoose.Types.ObjectId();
  const title = "Fixture reviewer";
  const note = "fixture-only internal review";
  const material = "https://example.invalid/private-training-fixture";
  await WorkPosition.create({
    _id: positionId, serviceId, title, category: "microjobs", requirements: "QA experience",
    adminNotes: note, trainingMaterials: [{ title: "Fixtures", type: "link", url: material }],
    skills: ["Test design"], workMode: "remote",
  });
  await Service.collection.insertOne({
    _id: serviceId, title: "Sample QA role", category: "microjobs", active: true,
    status: "active", price: 10, linkedJobId: positionId,
  });

  const server = require("../src/app").listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paths = ["/api/work-positions", `/api/work-positions/by-service/${serviceId}`];
  for (const pathname of paths) {
    await t.test(pathname.split("?")[0], async () => {
      const response = await fetch(base + pathname);
      assert.equal(response.status, 200);
      const data = await response.json();
      const position = Array.isArray(data) ? data[0] : data.position;
      assert.equal(position._id, positionId.toString());
      assert.equal(position.title, title);
      assert.equal(position.hasScreening, false);
      assert.deepEqual(position.skills, ["Test design"]);
      assert.equal(position.workMode, "remote");
      for (const restricted of [note, material, '"trainingMaterials"', '"adminNotes"']) {
        assert.ok(!JSON.stringify(data).includes(restricted));
      }
    });
  }
  await t.test("editors publish, clear, and withdraw a specialization brief without exposing private data", async () => {
    const admin = new mongoose.Types.ObjectId(), member = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
      { _id: admin, role:"admin", email:"editor@example.test" }, { _id: member, role:"user", email:"member@example.test" },
    ]);
    const path = "/api/admin/work-positions";
    async function write(url, method, actor, body) {
      const response = await fetch(base + url, { method, headers: {
        "Content-Type": "application/json", Authorization: "Bearer " + jwt.sign({ id: actor.toString() }, process.env.JWT_SECRET),
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }
    const input = {
      title: "Release review", category: "qa", description: "Review release checklists.", requirements: "First line\nSecond line",
      experienceLevel: "entry", workMode: "hybrid", locationEligibility: "Greater Manchester", timeCommitment: "Two afternoons per project",
      skills: [" Issue triage ", "QA"], responsibilities: ["Review release notes.", "Reproduce reported issues."], adminNotes: note,
    };
    assert.equal((await write(path, "POST", member, input)).status, 403);
    const created = await write(path, "POST", admin, input);
    assert.equal(created.status, 201);
    const id = created.body._id;
    const findPublic = async () => (await (await fetch(base + "/api/work-positions")).json()).find(role => role._id === id);
    const published = await findPublic();
    for (const key of ["description", "requirements", "experienceLevel", "workMode", "locationEligibility", "timeCommitment", "responsibilities"]) {
      assert.deepEqual(published[key], input[key]);
    }
    assert.deepEqual(published.skills, ["Issue triage", "QA"]);
    assert.equal(published.adminNotes, undefined);
    assert.equal(published.rentPrice, undefined);
    const headers = { Authorization: "Bearer " + jwt.sign({id:admin.toString()}, process.env.JWT_SECRET) };
    const adminRole = await (await fetch(base + "/api/admin/workspace/job/" + id,{ headers })).json();
    assert.equal(adminRole.job.experienceLevel, "entry");
    assert.equal(adminRole.job.adminNotes, note);
    assert.equal((await write(path + "/" + id, "PUT", member, { skills: [] })).status, 403);
    for (const invalid of [
      { experienceLevel:"lead" }, { workMode:["hybrid"] }, { locationEligibility:"X".repeat(161) }, { timeCommitment:"one\ntwo" },
      { skills:Array(13).fill("x") }, { skills:[" A", "a "] }, { skills:["x".repeat(65)] }, { responsibilities:[" "] },
      { responsibilities:["first", 24] }, { responsibilities: { $set:"bad" } }, { rentPrice: 12 },
    ]) assert.equal((await write(path + "/" + id, "PUT", admin, invalid)).status, 400);
    assert.deepEqual((await findPublic()).skills, ["Issue triage", "QA"]);
    const firstEdit = await write(path + "/" + id, "PUT", admin, {
      expectedRevision: created.body.revision, workMode:"remote", experienceLevel:"advanced", timeCommitment:"", responsibilities:[],
    });
    assert.equal(firstEdit.status, 200);
    assert.equal((await write(path + "/" + id, "PUT", admin, { expectedRevision:created.body.revision, skills:[] })).status, 409);
    const updated = await findPublic();
    assert.deepEqual(updated.skills, ["Issue triage","QA"]);
    assert.equal(updated.workMode, "remote");
    assert.equal(updated.experienceLevel, "advanced");
    assert.deepEqual(updated.responsibilities, []);
    assert.equal(updated.timeCommitment, "");
    const hidden = await write(path + "/" + id, "PUT", admin,{ active:false, expectedRevision:firstEdit.body.revision });
    assert.equal(hidden.status, 200);
    assert.equal(await findPublic(), undefined);
  });
  await t.test("historical briefs stay editable while role discovery, counts and applications agree", async () => {
    const common = { category: "qa", active: true };
    const [fixture, formerService, validRole] = await WorkPosition.create([
      { ...common, title: "Test Data Entry Role", description: "Test position for PATCH_44 multi-job validation" },
      { ...common, title: "Outlier AI", description: "Screening without getting detected their AI detection system",
        requirements: "Must be onboarded to an account for screening test" },
      { ...common, title: "Outlier AI", description: "Assess model outputs using an approved rubric.", requirements: "QA experience" },
    ]);
    const worker = await User.findOne({ role: "user" });
    const editor = await User.findOne({ role: "admin" });
    const headers = actor => ({ "Content-Type": "application/json", Authorization: "Bearer " + jwt.sign({ id: actor.id }, process.env.JWT_SECRET) });
    const directory = await (await fetch(base + "/api/work-positions")).json();
    assert.ok(directory.some(role => role._id === validRole.id));
    const stats = await (await fetch(base + "/api/public/stats")).json();
    assert.equal(stats.stats.activeJobRoles, directory.length);
    const adminRoles = await (await fetch(base + "/api/admin/work-positions", { headers: headers(editor) })).json();
    for (const excluded of [fixture, formerService]) {
      assert.ok(!directory.some(role => role._id === excluded.id));
      const adminRow = adminRoles.find(role => role._id === excluded.id);
      assert.equal(adminRow.isSpecialization, false);
      assert.ok(adminRow.directoryExclusionReason);
      const application = await fetch(base + "/api/workspace/apply/" + excluded.id, {
        method: "POST", headers: headers(worker), body: JSON.stringify({}),
      });
      assert.equal(application.status, 404);
    }
    const edit = await fetch(base + "/api/admin/work-positions/" + formerService.id, {
      method: "PUT", headers: headers(editor), body: JSON.stringify({
        expectedRevision: adminRoles.find(role => role._id === formerService.id).revision,
        description: "Evaluate anonymized datasets under an approved rubric.", requirements: "Experience with data quality.",
      }),
    });
    assert.equal(edit.status, 200);
    assert.ok((await (await fetch(base + "/api/work-positions")).json()).some(role => role._id === formerService.id));
  });
  await t.test("retired catalogue returns a migration notice without disclosing listings", async () => {
    const response = await fetch(base + "/api/services/marketplace?intent=all");
    assert.equal(response.status, 410);
    const data = await response.json();
    assert.equal(data.marketplace, "/api/opportunities");
    assert.equal(data.services, undefined);
  });
  const stored = await WorkPosition.findById(positionId).lean();
  assert.equal(stored.adminNotes, note);
  assert.equal(stored.trainingMaterials[0].url, material);
});
