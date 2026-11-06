const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const WorkPosition = require("../src/models/WorkPosition");
const Service = require("../src/models/Service");

const port = process.env.UREMO_TEST_MONGO_PORT;
test("public role and marketplace responses exclude internal notes and project resources", { skip: !port }, async (t) => {
  assert.match(port, /^\d{1,5}$/);
  const database = "uremo_test_" + randomUUID().replaceAll("-", "");
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
      for (const restricted of [note, material, '"trainingMaterials"', '"adminNotes"']) {
        assert.ok(!JSON.stringify(data).includes(restricted));
      }
    });
  }
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
