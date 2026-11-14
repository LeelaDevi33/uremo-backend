const mongoose = require("mongoose");
const WorkPosition = require("../models/WorkPosition");
const Opportunity = require("../models/Opportunity");
const ApplyWork = require("../models/ApplyWork");
const Project = require("../models/Project");
const Service = require("../models/Service");
const ProofOfWork = require("../models/ProofOfWork");
const { catalogFields, directoryExclusions } = require("./roleCatalog");

function roleError(status, message) { return Object.assign(new Error(message), { status }); }
function revision(record) { return (record.updatedAt || record.createdAt || record._id.getTimestamp()).toISOString(); }
function withRevision(record) {
  return { ...(record.toObject ? record.toObject() : record), revision: revision(record) };
}
async function readRole(id, expectedRevision, session) {
  if (!mongoose.isObjectIdOrHexString(id)) throw roleError(400, "Invalid work role ID");
  const role = await WorkPosition.findById(id).session(session);
  if (!role) throw roleError(404, "Work role not found");
  if (expectedRevision !== undefined && expectedRevision !== revision(role)) {
    throw roleError(409, "This work role changed. Reload before saving.");
  }
  return role;
}
async function editRole(id, expectedRevision, changes) {
  return WorkPosition.db.transaction(async session => {
    const role = await readRole(id, expectedRevision, session);
    const next = new Date(Math.max(Date.now(), Date.parse(revision(role)) + 1));
    role.set(changes);
    role.updatedAt = next;
    await role.save({ session, timestamps: false });
    return withRevision(role);
  });
}
async function removeRole(id, expectedRevision) {
  await WorkPosition.db.transaction(async session => {
    const role = await readRole(id, expectedRevision, session);
    // Every opportunity link and application also touches the role, so a
    // concurrent reference or deletion must retry before either can commit.
    await WorkPosition.deleteOne({ _id: id }, { session });
    for (const [model, filter] of [[Opportunity,{ $or: [{ workPositionId: id }, { projectRoleId: id }] }], [ApplyWork,{ position: id }],
      [Project,{ workPositionId: id }], [ProofOfWork,{ jobRoleId: id }], [Service,{ linkedJobId: id }]]) {
      if (await model.exists(filter).session(session)) throw roleError(409, "This role has linked records. Deactivate it to preserve its history.");
    }
    if (role.serviceId) throw roleError(409, "This role has a historical service link. Deactivate it instead.");
  });
}
async function reviewApplication(id, status, { roleId, adminId, reason } = {}) {
  if (!mongoose.isObjectIdOrHexString(id) || !["pending", "approved", "rejected"].includes(status)) throw roleError(400, "Invalid application or review status");
  return ApplyWork.db.transaction(async session => {
    const applicant = await ApplyWork.findOne({ _id: id, ...(roleId ? { position: roleId } : {}) }).session(session);
    if (!applicant) throw roleError(404, "Application not found");
    const job = applicant.position ? await WorkPosition.findById(applicant.position)
      .select(catalogFields + " hasScreening screeningId screeningIds").session(session).lean() : null;
    if (applicant.status === status) return { applicant, job, changed: false };
    if (applicant.currentProject) throw roleError(409, "Resolve the current assignment before changing the application decision");
    if (status === "approved" && applicant.position && !job) throw roleError(409, "The application role requires review");
    if (status === "approved" && job && (await directoryExclusions([job], session)).size) throw roleError(409, "This role is archived and cannot accept new approvals");
    applicant.status = status;
    if (status === "approved") {
      applicant.approvedBy = adminId;
      applicant.approvedAt = new Date();
      applicant.workerStatus = (job?.hasScreening && job?.screeningId) || job?.screeningIds?.length ? "screening_unlocked" : "ready_to_work";
    } else {
      applicant.workerStatus = status === "pending" ? "applied" : "inactive";
      if (reason !== undefined) applicant.adminNotes = reason;
    }
    await applicant.save({ session });
    return { applicant, job, changed: true };
  });
}
module.exports = { roleError, revision, withRevision, editRole, removeRole, reviewApplication };
