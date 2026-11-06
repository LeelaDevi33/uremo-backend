const { parseArgs } = require("node:util");
const mongoose = require("mongoose");
const Offer = require("../src/models/Opportunity");
const Grant = require("../src/models/OpportunityGrant");

// Read-only counts. Do not infer project identity from a role, title, or receipt.
async function inventory() {
  const legacy = { $or: [{ projectId: null }, { projectRoleId: null }, { workPositionId: { $type: "objectId" } }, { applyEnabled: { $ne: false } }] };
  const [rows, historicalGrants] = await Promise.all([
    Offer.aggregate([{ $match: legacy }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Grant.countDocuments({ projectId: null }),
  ]);
  return { mode: "read-only", offersNeedingReviewByStatus: Object.fromEntries(rows.map(r => [String(r._id), r.count])), historicalGrants };
}
async function main() {
  const { values } = parseArgs({ options: { db: { type: "string" }, port: { type: "string", default: "27347" } } });
  if (!/^[a-z][a-z0-9_-]{0,60}$/i.test(values.db || "") || ["admin","config","local"].includes(values.db.toLowerCase()) ||
    !/^\d{1,5}$/.test(values.port) || +values.port < 1 || +values.port > 65535) throw new Error("Invalid local database or port");
  await mongoose.connect(`mongodb://127.0.0.1:${values.port}/${values.db}?directConnection=true`,
    { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 4000 });
  try { console.log(JSON.stringify(await inventory(), null, 2)); } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error("Review requires a named local database; unsupported arguments and writes are rejected."); process.exitCode = 1; });
module.exports = { inventory };
