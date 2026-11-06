const mongoose = require("mongoose");
const Grant = require("../models/OpportunityGrant");
const { paidProjectAccess } = require("./paidProjectAccess");

// A paid receipt delivers its agreed scope and handoff. It is not a job
// assignment and must not expose another worker's submissions or payroll.
async function acquiredProjects(userId, projectId) {
  const now = new Date();
  const query = Grant.find({
    userId, projectId: projectId || { $type: "objectId" }, startsAt: { $lte: now },
    $or: [{ type: "buy", endsAt: null }, { type: "rent", endsAt: { $gt: now } }],
  }).select("projectId opportunityId title projectScope type endsAt startsAt" + (projectId ? " +deliverable" : ""))
    .sort({ startsAt: -1 }).lean();
  const receipts = await query;
  const states = await paidProjectAccess(userId, receipts.map(row => row.projectId));
  const found = new Set();
  return receipts.flatMap(row => {
    const id = String(row.projectId);
    const state = states.get(id);
    if (!state?.required || !state.active || state.opportunityId !== String(row.opportunityId) || found.has(id)) return [];
    found.add(id);
    return [{ _id: row.projectId, opportunityId: row.opportunityId, title: row.title,
      description: row.projectScope, accessType: row.type, endsAt: row.endsAt,
      ...(projectId ? { handoff: row.deliverable } : {}) }];
  });
}

async function workAssignmentsOnly(req, res, next) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: "Project not found" });
    const access = (await paidProjectAccess(null, [req.params.id])).get(req.params.id.toLowerCase());
    if (access?.required) return res.status(403).json({ message: "This action is for assigned work only." });
    return next();
  } catch (err) { return next(err); }
}

module.exports = { acquiredProjects, workAssignmentsOnly };
