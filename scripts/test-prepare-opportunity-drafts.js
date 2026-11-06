const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const Offer = require("../src/models/Opportunity");
const Grant = require("../src/models/OpportunityGrant");
const { inventory } = require("./review-project-offers");

test("retired import cannot generate a purchasable project from a role", () => {
  const cmd = path.join(__dirname, "prepare-opportunity-drafts.js");
  assert.match(execFileSync(process.execPath,[cmd,"--help"],{encoding:"utf8"}), /retired/);
  assert.throws(() => execFileSync(process.execPath,[cmd,"--db","foo","--role","a".repeat(24),"--write"], {stdio:"pipe"}));
});
test("review reports legacy and mixed offers including settled historical access without writing", { skip: !process.env.UREMO_TEST_MONGO_PORT }, async t => {
  const db = "uremo_test_review_" + randomUUID().replaceAll("-","");
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.UREMO_TEST_MONGO_PORT}/${db}`, { autoIndex:false, autoCreate:false });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const projectId = new mongoose.Types.ObjectId(), projectRoleId = new mongoose.Types.ObjectId();
  await Offer.collection.insertMany([{ status:"published",applyEnabled:true },{ status:"draft",projectId,projectRoleId,applyEnabled:true },
    { status:"published",projectId,projectRoleId,applyEnabled:false }]);
  await Grant.collection.insertMany([{ title:"Earlier receipt" },{ projectId,title:"Current receipt" }]);
  assert.deepEqual(await inventory(),{ mode:"read-only",offersNeedingReviewByStatus:{published:1,draft:1},historicalGrants:1 });
  assert.equal(await Offer.countDocuments(),3);
  assert.equal(await Grant.countDocuments(),2);
});
