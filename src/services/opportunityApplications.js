const Opportunity = require("../models/Opportunity");
const ApplyWork = require("../models/ApplyWork");
const WorkPosition = require("../models/WorkPosition");
const rolePolicyFields = "status firstPublishedAt soldAt applyEnabled rightsConfirmed +preserveRoleUntilPublished";

function applicationError(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertApplicationOpen(listing) {
  // A reviewed import is a draft copy of an already open role. Its free hiring
  // flow stays open until the admin publishes, archives, disables or relinks it.
  if (listing?.preserveRoleUntilPublished && listing.status === "draft" && !listing.firstPublishedAt &&
      !listing.soldAt && listing.applyEnabled) return;
  if (listing && (listing.status !== "published" || !listing.rightsConfirmed || !listing.applyEnabled || listing.soldAt)) {
    throw applicationError(409, "Applications are closed for this opportunity");
  }
}

async function preflightApplication(position, userId) {
  if (!position.active) throw applicationError(400, "This position is not active");
  const listing = await Opportunity.findOne({ workPositionId: position._id }).select(rolePolicyFields).lean();
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
    const listing = await Opportunity.findOne({ workPositionId: fields.position }).select(rolePolicyFields).session(session);
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
    $nor: [{ preserveRoleUntilPublished: true, status: "draft", firstPublishedAt: null, soldAt: null, applyEnabled: true }],
    $or: [{ status: { $ne: "published" } }, { rightsConfirmed: false }, { applyEnabled: false }, { soldAt: { $ne: null } }],
  });
}

module.exports = { createRoleApplication, preflightApplication, unavailablePositionIds };
