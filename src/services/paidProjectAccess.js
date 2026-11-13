const Opportunity = require("../models/Opportunity");
const Grant = require("../models/OpportunityGrant");

// Used by workspace reads and work submissions in addition to their normal
// assignment checks. A missing or malformed receipt must never unlock a project.
async function paidProjectAccess(userId, projectIds, { session } = {}) {
  const ids = [...new Set(projectIds.filter(Boolean).map(String))];
  const states = new Map(ids.map(id => [id, { required: false, active: true, state: "standard", opportunityId: null }]));
  if (!ids.length) return states;
  const offers = await Opportunity.find({ projectId: { $in: ids } }).select("projectId").session(session || null).lean();
  for (const offer of offers) {
    states.set(String(offer.projectId), { required: true, active: false, state: "unpaid", opportunityId: String(offer._id) });
  }
  if (!offers.length || !userId) return states;
  const now = new Date();
  const grants = await Grant.find({
    userId, refundedAt: null, projectId: { $in: ids }, opportunityId: { $in: offers.map(item => item._id) }, startsAt: { $lte: now },
  }).select("projectId opportunityId type endsAt").sort({ startsAt: -1 }).session(session || null).lean();
  for (const grant of grants) {
    const access = states.get(String(grant.projectId));
    if (access.opportunityId !== String(grant.opportunityId) || access.active) continue;
    if (grant.type === "buy" && grant.endsAt === null) Object.assign(access, { active: true, state: "owned" });
    if (grant.type === "rent" && grant.endsAt instanceof Date) {
      const active = grant.endsAt > now;
      Object.assign(access, { active, state: active ? "rented" : "expired" });
    }
  }
  return states;
}

module.exports = { paidProjectAccess };
