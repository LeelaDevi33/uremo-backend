const Project = require("../models/Project");
const ApplyWork = require("../models/ApplyWork");
const WorkPosition = require("../models/WorkPosition");
const Opportunity = require("../models/Opportunity");
const WalletTransaction = require("../models/WalletTransaction");
const { changeFunds, isWalletAmount } = require("./walletFunds");
const { roleError } = require("./adminWorkRoles");
const { passedScreening } = require("./applicationScreenings");

function meetsScreenings(worker, project, role) {
  const required = [project.screeningId, ...(project.screeningIds || [])];
  if (role?.hasScreening) {
    if (!role.screeningId && !role.screeningIds?.length) return false;
    required.push(role.screeningId, ...(role.screeningIds || []));
  }
  const passed = new Set((worker.screeningsCompleted || []).filter(passedScreening).map(s => String(s.screeningId)));
  return required.filter(Boolean).every(id => passed.has(String(id)));
}

async function assign(projectId, applicationId, roleId) {
  if (![projectId, applicationId, ...(roleId ? [roleId] : [])].every(id => Project.base.isObjectIdOrHexString(id))) {
    throw roleError(400, "Invalid project, role or worker ID");
  }
  return Project.db.transaction(async session => {
    const project = await Project.findById(projectId).session(session);
    if (!project) throw roleError(404, "Project not found");
    if (project.status !== "open" || project.assignedTo) throw roleError(409, "Only an open, unassigned project can be assigned");
    if (await Opportunity.exists({ projectId }).session(session)) throw roleError(409, "This project is reserved for marketplace access");
    const worker = await ApplyWork.findById(applicationId).session(session);
    if (!worker) throw roleError(404, "Worker application not found");
    if (roleId && String(worker.position) !== roleId || project.workPositionId && !project.workPositionId.equals(worker.position)) {
      throw roleError(409, "Project and worker must belong to the same role");
    }
    if (worker.status !== "approved" || worker.workerStatus !== "ready_to_work" || worker.currentProject) {
      throw roleError(409, "Worker must be approved, ready and available for assignment");
    }
    const role = worker.position ? await WorkPosition.findById(worker.position).session(session).lean() : null;
    if (project.workPositionId && !role || !meetsScreenings(worker, project, role)) throw roleError(409, "Worker lacks a required role or passed screening");
    if (roleId && !project.workPositionId && project.category !== role?.category) throw roleError(409, "Legacy project category does not match this role");
    project.set({ assignedTo: worker.user, assignedAt: new Date(), status: "assigned" });
    if (roleId && !project.workPositionId) project.workPositionId = roleId;
    worker.set({ workerStatus: "assigned", currentProject: project._id });
    await project.save({ session });
    await worker.save({ session });
    return { project, worker };
  });
}

async function createForRole(fields) {
  return Project.db.transaction(async session => {
    if (fields.workPositionId) {
      if (!Project.base.isObjectIdOrHexString(fields.workPositionId)) throw roleError(400, "Invalid work role");
      const role = await WorkPosition.findOneAndUpdate({ _id: fields.workPositionId }, { $inc: { applicationRevision: 1 } },
        { session, timestamps: false }).select("category hasScreening screeningId screeningIds").lean();
      if (!role) throw roleError(404, "Work role not found");
      const category = role.category;
      const roleIds = role.hasScreening ? [role.screeningId, ...(role.screeningIds || [])] : [];
      const required = [...new Set([...roleIds, fields.screeningId, ...(fields.screeningIds || [])].filter(Boolean).map(String))];
      fields = { ...fields, category,
        screeningId: required[0], screeningIds: required };
    }
    if (typeof fields.category !== "string" || !fields.category.trim() || fields.category.trim().length > 48) {
      throw roleError(400, "A project category of 1 to 48 characters is required");
    }
    const [project] = await Project.create([fields], { session, ordered: true });
    return project;
  });
}

async function creditCompleted(projectId, amount, rating) {
  if (!Project.base.isObjectIdOrHexString(projectId) || !isWalletAmount(amount)) throw roleError(400, "A completed project and a positive USD amount in whole cents are required");
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw roleError(400, "Choose a rating between 1 and 5");
  return Project.db.transaction(async session => {
    const project = await Project.findById(projectId).session(session);
    if (!project) throw roleError(404, "Project not found");
    if (project.status !== "completed" || !project.assignedTo || project.earningsCredited ||
        await WalletTransaction.exists({ referenceId: project._id, source: "earning", status: "success" }).session(session)) {
      throw roleError(409, "Credit requires a completed, assigned project with no previous earnings payment");
    }
    const funds = await changeFunds(project.assignedTo, amount, "earning", session);
    project.set({ earningsCredited: amount, creditedAt: new Date() });
    if (rating != null) project.adminRating = rating;
    await project.save({ session });
    const query = { user: project.assignedTo };
    if (project.workPositionId) query.position = project.workPositionId;
    const worker = await ApplyWork.findOne(query).sort({ createdAt: -1 }).session(session);
    if (worker) {
      worker.totalEarnings = Math.round(((worker.totalEarnings || 0) + amount) * 100) / 100;
      worker.projectsCompleted.push({ projectId: project._id, completedAt: project.completedAt, rating, earnings: amount });
      if (worker.currentProject?.equals(project._id)) worker.set({ currentProject: null, workerStatus: "ready_to_work" });
      await worker.save({ session });
    }
    await WalletTransaction.create([{
      user: project.assignedTo, type: "credit", amount, source: "earning", status: "success", provider: "internal",
      referenceId: project._id, description: "Earnings for project: " + project.title,
      balanceBefore: funds.balanceBefore, balanceAfter: funds.walletBalance,
    }], { session, ordered: true });
    return project;
  });
}
module.exports = { assign, creditCompleted, createForRole, meetsScreenings };
