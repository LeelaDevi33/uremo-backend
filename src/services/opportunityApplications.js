const Opportunity = require("../models/Opportunity");
const ApplyWork = require("../models/ApplyWork");
const WorkPosition = require("../models/WorkPosition");

function applicationError(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertApplicationOpen(listing) {
  if (listing && (listing.status !== "published" || !listing.rightsConfirmed || !listing.applyEnabled || listing.soldAt)) {
    throw applicationError(409, "Applications are closed for this opportunity");
  }
}

async function preflightApplication(position, userId) {
  if (!position.active) throw applicationError(400, "This position is not active");
  const listing = await Opportunity.findOne({ workPositionId: position._id }).select("status soldAt applyEnabled rightsConfirmed").lean();
  assertApplicationOpen(listing);
  if (await ApplyWork.exists({ user: userId, position: position._id })) throw applicationError(409, "Already applied to this position");
}

async function createRoleApplication(fields) {
  if (fields.resumeUrl) {
    let url;
    try { url = new URL(fields.resumeUrl); } catch { /* Invalid URLs are rejected below. */ }
    if (typeof fields.resumeUrl !== "string" || !/^https:\/\//i.test(fields.resumeUrl) ||
        url?.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw applicationError(400, "Provide an HTTPS resume link without embedded credentials");
    }
  }
  if (!fields.position) return ApplyWork.create(fields);
  return Opportunity.db.transaction(async session => {
    const role = await WorkPosition.findOneAndUpdate(
      { _id: fields.position, active: true }, { $inc: { applicationRevision: 1 } }, { session, timestamps: false },
    );
    if (!role) throw applicationError(400, "This position is not active");
    const listing = await Opportunity.findOne({ workPositionId: fields.position }).select("status soldAt applyEnabled rightsConfirmed").session(session);
    assertApplicationOpen(listing);
    if (listing) {
      // Serialize qualification requests with sales and changes to the listing.
      await Opportunity.updateOne({ _id: listing._id }, { $inc: { applicationCount: 1 } }, { session, timestamps: false });
    }
    const previous = await ApplyWork.exists({ user: fields.user, position: fields.position }).session(session);
    if (previous) throw applicationError(409, "Already applied to this position");
    const [application] = await ApplyWork.create([fields], { session, ordered: true });
    return application;
  });
}

async function unavailablePositionIds() {
  return Opportunity.distinct("workPositionId", {
    workPositionId: { $ne: null },
    $or: [{ status: { $ne: "published" } }, { rightsConfirmed: false }, { applyEnabled: false }, { soldAt: { $ne: null } }],
  });
}

module.exports = { createRoleApplication, preflightApplication, unavailablePositionIds };
