/**
 * PATCH_43: Admin Job Role Controller
 * PATCH_49: Enhanced with notifications for approval/screening unlock
 * Full control over job roles, applicants, screenings, and assignments
 */
const mongoose = require("mongoose");
const ApplyWork = require("../models/ApplyWork");
const WorkPosition = require("../models/WorkPosition");
const Screening = require("../models/Screening");
const Project = require("../models/Project");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { withRevision, editRole, roleError, reviewApplication } = require("../services/adminWorkRoles");
const roleProjects = require("../services/roleProjects");

// ============ JOB ROLE MANAGEMENT ============

/**
 * GET /api/admin/workspace/job/:id
 * Get full job role details with stats
 */
exports.getJobRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Invalid job ID" });
    }

    const job = await WorkPosition.findById(id)
      .populate("screeningId", "title passingScore timeLimit")
      .populate("screeningIds", "title passingScore timeLimit")
      .populate("serviceId", "title category")
      .lean();

    if (!job) {
      return res.status(404).json({ ok: false, message: "Job role not found" });
    }

    // Get applicant counts by status
    const applicantCounts = await ApplyWork.aggregate([
      { $match: { position: new mongoose.Types.ObjectId(id) } },
      { $group: { _id: "$workerStatus", count: { $sum: 1 } } },
    ]);

    const countsByStatus = {};
    applicantCounts.forEach((c) => {
      countsByStatus[c._id] = c.count;
    });

    res.json({
      ok: true,
      job: withRevision(job),
      stats: {
        totalApplicants: Object.values(countsByStatus).reduce(
          (a, b) => a + b,
          0,
        ),
        applied: countsByStatus.applied || 0,
        screeningUnlocked: countsByStatus.screening_unlocked || 0,
        testSubmitted: countsByStatus.test_submitted || 0,
        failed: countsByStatus.failed || 0,
        readyToWork: countsByStatus.ready_to_work || 0,
        assigned: countsByStatus.assigned || 0,
        working: countsByStatus.working || 0,
        suspended: countsByStatus.suspended || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * GET /api/admin/workspace/job/:id/applicants
 * Get all applicants for a job role with filtering
 */
exports.getApplicants = async (req, res) => {
  try {
    const { id } = req.params;
    const { workerStatus, page = 1, limit = 20 } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Invalid job ID" });
    }

    const filter = { position: new mongoose.Types.ObjectId(id) };
    if (workerStatus) {
      filter.workerStatus = workerStatus;
    }

    const total = await ApplyWork.countDocuments(filter);
    const applicants = await ApplyWork.find(filter)
      .populate("user", "name email createdAt")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    res.json({
      ok: true,
      applicants,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/approve
 * Approve an applicant (changes status from pending to approved)
 * PATCH_57: Also updates workerStatus based on screening availability
 */
exports.approveApplicant = async (req, res) => {
  try {
    const { applicant, job, changed } = await reviewApplication(req.body.applicantId, "approved", { roleId: req.params.id, adminId: req.user.id });
    if (!changed) return res.json({ ok: true, applicant, workerStatus: applicant.workerStatus });
    const hasScreenings = applicant.workerStatus === "screening_unlocked";

    // PATCH_49: Send notification to worker
    try {
      const notifMessage =
        applicant.workerStatus === "screening_unlocked"
          ? `Your application for "${job?.title || "the position"}" has been approved! Complete the screening test to start working.`
          : `Your application for "${job?.title || "the position"}" has been approved! You're ready to start working.`;

      await Notification.create({
        user: applicant.user,
        title: "Application Approved! 🎉",
        message: notifMessage,
        type: "workspace",
        resourceType: "application",
        resourceId: applicant._id,
      });
    } catch (notifErr) {
      console.error("Failed to create approval notification:", notifErr);
    }

    res.json({
      ok: true,
      message: "Applicant approved",
      applicant,
      workerStatus: applicant.workerStatus,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/reject
 * Reject an applicant
 */
exports.rejectApplicant = async (req, res) => {
  try {
    const { applicant } = await reviewApplication(req.body.applicantId, "rejected", { roleId: req.params.id, adminId: req.user.id, reason: req.body.reason });

    res.json({
      ok: true,
      message: "Applicant rejected",
      applicant,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/unlock-screening
 * Unlock screening for an approved applicant
 */
exports.unlockScreening = async (req, res) => {
  try {
    const { id } = req.params;
    const { applicantId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(applicantId)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid applicant ID" });
    }

    const job = await WorkPosition.findById(id).select("title hasScreening screeningId screeningIds").lean();
    if (!job || (!job.screeningIds?.length && !(job.hasScreening && job.screeningId))) {
      return res.status(409).json({ ok: false, message: "Attach a screening before unlocking it" });
    }
    const applicant = await ApplyWork.findOneAndUpdate({ _id: applicantId, position: id, status: "approved", currentProject: null,
      workerStatus: { $in: ["applied", "fresh", "screening_available", "ready_to_work"] } },
      { $set: { workerStatus: "screening_unlocked" } }, { new: true });
    if (!applicant) {
      const existing = await ApplyWork.findOne({ _id: applicantId, position: id });
      if (!existing) return res.status(404).json({ ok: false, message: "Applicant not found" });
      if (existing.status === "approved" && existing.workerStatus === "screening_unlocked") return res.json({ ok: true, applicant: existing });
      return res.status(409).json({ ok: false, message: "Resolve the current assignment or application state before unlocking screening" });
    }

    // PATCH_49: Send notification to worker
    try {
      await Notification.create({
        user: applicant.user,
        title: "Screening Unlocked! 📚",
        message: `Your screening for "${job?.title || "the position"}" is now available. Review the training materials and take the test.`,
        type: "workspace",
        resourceType: "application",
        resourceId: applicant._id,
      });
    } catch (notifErr) {
      console.error("Failed to create screening notification:", notifErr);
    }

    res.json({
      ok: true,
      message: "Screening unlocked for applicant",
      applicant,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/set-training
 * Set training materials for the job role
 */
exports.setTraining = async (req, res) => {
  try {
    const { id } = req.params;
    const { trainingMaterials } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Invalid job ID" });
    }

    if (!Array.isArray(trainingMaterials) || trainingMaterials.length > 50) throw roleError(400, "Provide up to 50 training materials");
    const rows = trainingMaterials.map(material => {
      const { title, type = "link", url, description = "" } = material || {};
      if (typeof url !== "string" || url.length > 2048 || !/^https:\/\//i.test(url) ||
          typeof title !== "string" || !title.trim() || title.length > 160 ||
          !["link", "pdf", "video"].includes(type) || typeof description !== "string" || description.length > 2000) {
        throw roleError(400, "Each training material requires a title, supported type and HTTPS URL");
      }
      let parsed;
      try { parsed = new URL(url); } catch { throw roleError(400, "Invalid training URL"); }
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) throw roleError(400, "Invalid training URL");
      return { title: title.trim(), type, url: parsed.href, description: description.trim() };
    });
    const job = await editRole(id, req.body.expectedRevision, { trainingMaterials: rows });

    res.json({
      ok: true,
      message: "Training materials updated",
      job,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/set-screening
 * Attach a screening to the job role
 * PATCH_52A: Inline screening creation removed (centralized screenings only)
 */
exports.setScreening = async (req, res) => {
  try {
    const { id } = req.params;
    const { screeningId, screeningIds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Invalid job ID" });
    }

    let ids;
    if (screeningIds !== undefined) {
      if (!Array.isArray(screeningIds) || screeningIds.length > 50) throw roleError(400, "Provide a screening list of up to 50 IDs");
      ids = screeningIds;
    } else if (screeningId !== undefined) {
      ids = screeningId === null || screeningId === "" ? [] : [screeningId];
    } else throw roleError(400, "Provide screeningIds, or an empty list to clear the assignment");
    if (ids.some(sid => !mongoose.isObjectIdOrHexString(sid))) throw roleError(400, "Invalid screening ID");
    ids = ids.map(sid => String(sid).toLowerCase());
    if (new Set(ids).size !== ids.length) throw roleError(400, "A screening can only appear once");
    if (await Screening.countDocuments({ _id: { $in: ids } }) !== ids.length) throw roleError(404, "A selected screening no longer exists");
    const update = { screeningIds: ids, screeningId: ids[0] || null, hasScreening: ids.length > 0 };
    const updatedJob = await editRole(id, req.body.expectedRevision, update);
    await WorkPosition.populate(updatedJob, [
      { path: "screeningId", select: "title passingScore timeLimit questions" }, { path: "screeningIds", select: "title passingScore timeLimit" },
    ]);

    res.json({
      ok: true,
      message: update.hasScreening
        ? `${(update.screeningIds || []).length} screening(s) attached to job role`
        : "Screenings cleared from job role",
      job: updatedJob,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/assign-project
 * Assign a project to a worker in this job role
 */
exports.assignProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { applicantId, projectId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(applicantId)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid applicant ID" });
    }
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ ok: false, message: "Invalid project ID" });
    }

    const { project, worker: applicant } = await roleProjects.assign(projectId, applicantId, id);

    res.json({
      ok: true,
      message: "Project assigned to worker",
      applicant,
      project,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/job/:id/set-status
 * Manually set worker status (admin override)
 * PATCH-64: Enhanced with state machine validation and audit logging
 */
exports.setWorkerStatus = async (req, res) => {
  try {
    const { canTransitionWorkerStatus } = require("../core/workerStateMachine");
    const { logAdminAction } = require("../services/adminAudit.service");

    const { id } = req.params;
    const { applicantId, workerStatus, resetAttempts, adminNotes, payRate } =
      req.body;

    if (!mongoose.Types.ObjectId.isValid(applicantId)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid applicant ID" });
    }

    const validStatuses = [
      "applied",
      "screening_unlocked",
      "test_submitted",
      "failed",
      "ready_to_work",
      "assigned",
      "working",
      "suspended",
    ];

    if (!validStatuses.includes(workerStatus)) {
      return res.status(400).json({
        ok: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const applicant = await ApplyWork.findOne({
      _id: applicantId,
      position: id,
    });

    if (!applicant) {
      return res
        .status(404)
        .json({ ok: false, message: "Applicant not found" });
    }

    const previousStatus = applicant.workerStatus || "fresh";

    // PATCH-64 GUARDRAIL: Validate state machine transition
    const transitionCheck = canTransitionWorkerStatus(
      previousStatus,
      workerStatus,
    );

    if (!transitionCheck.allowed && previousStatus !== workerStatus) {
      return res.status(400).json({
        ok: false,
        message: `Invalid status transition: "${previousStatus}" → "${workerStatus}"`,
        reason: transitionCheck.reason,
        currentStatus: previousStatus,
        requestedStatus: workerStatus,
        hint: "Use valid state transitions only",
      });
    }

    applicant.workerStatus = workerStatus;

    if (resetAttempts) {
      applicant.attemptCount = 0;
    }

    if (adminNotes !== undefined) {
      applicant.adminNotes = adminNotes;
    }

    if (payRate !== undefined) {
      applicant.payRate = Number(payRate);
    }

    // If setting to ready_to_work, mark as approved
    if (workerStatus === "ready_to_work") {
      applicant.status = "approved";
      applicant.approvedBy = req.user.id;
      applicant.approvedAt = new Date();
    }

    await applicant.save();

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: "worker_status_change",
      entityType: "worker",
      entityId: String(applicantId),
      previousState: { workerStatus: previousStatus },
      newState: { workerStatus },
      reason: adminNotes || `Status changed by admin`,
      metadata: { positionId: id, resetAttempts, payRate },
    });

    res.json({
      ok: true,
      message: `Worker status set to ${workerStatus}`,
      applicant,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * GET /api/admin/workspace/jobs
 * Get all job roles with applicant counts
 */
exports.getAllJobRoles = async (req, res) => {
  try {
    const { active, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (active !== undefined) {
      filter.active = active === "true";
    }

    const total = await WorkPosition.countDocuments(filter);
    const jobs = await WorkPosition.find(filter)
      .populate("serviceId", "title category")
      .populate("screeningId", "title screeningType")
      .populate("screeningIds", "title screeningType passThreshold")
      .sort({ active: -1, sortOrder: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // Get applicant counts for each job
    const jobIds = jobs.map((j) => j._id);
    const applicantCounts = await ApplyWork.aggregate([
      { $match: { position: { $in: jobIds } } },
      {
        $group: {
          _id: { position: "$position", workerStatus: "$workerStatus" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Map counts to jobs
    const countMap = {};
    applicantCounts.forEach((c) => {
      const posId = c._id.position.toString();
      if (!countMap[posId]) {
        countMap[posId] = { total: 0 };
      }
      countMap[posId][c._id.workerStatus] = c.count;
      countMap[posId].total += c.count;
    });

    const enrichedJobs = jobs.map((j) => ({
      ...j,
      applicantStats: countMap[j._id.toString()] || { total: 0 },
    }));

    res.json({
      ok: true,
      jobs: enrichedJobs,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * PATCH_47: GET /api/admin/workspace/job/:id/projects
 * Get all projects for a job role
 */
exports.getJobProjects = async (req, res) => {
  try {
    const { id } = req.params;

    const job = await WorkPosition.findById(id).lean();
    if (!job) {
      return res.status(404).json({ ok: false, message: "Job role not found" });
    }

    // PATCH_88: Filter by workPositionId first, fallback to category
    const filter = job._id
      ? {
          $or: [
            { workPositionId: job._id },
            { category: job.category, workPositionId: { $exists: false } },
          ],
        }
      : { category: job.category };
    const projects = await Project.find(filter)
      .populate("assignedTo", "name email")
      .populate("screeningId", "title passingScore")
      .populate("screeningIds", "title passingScore")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

/**
 * PATCH_47: POST /api/admin/workspace/job/:id/projects
 * Create a new project for this job role
 */
exports.createJobProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, payRate, payType, deadline, instructions, priority } =
      req.body;

    const job = await WorkPosition.findById(id).lean();
    if (!job) {
      return res.status(404).json({ ok: false, message: "Job role not found" });
    }

    if (!title) {
      return res
        .status(400)
        .json({ ok: false, message: "Project title is required" });
    }

    const project = await roleProjects.createForRole({
      title,
      description: description || "",
      instructions: instructions || "",
      priority: priority || "medium",
      payRate: Number(payRate) || 0,
      payType: payType || "per_task",
      deadline: deadline ? new Date(deadline) : undefined,
      status: "draft",
      createdBy: req.user.id,
      workPositionId: id, // PATCH_88: Link project to job role
      screeningId: job.screeningId || undefined, // Inherit job role screening
    });

    res.status(201).json({ ok: true, project, message: "Project created" });
  } catch (err) {
    res.status(err.status || (["CastError", "ValidationError"].includes(err.name) ? 400 : 500)).json({ ok: false, message: err.message });
  }
};

/**
 * PATCH_47: PUT /api/admin/workspace/job/:id/projects/:projectId/activate
 * Activate a draft project
 */
exports.activateProject = async (req, res) => {
  try {
    const { projectId, id } = req.params;
    if (![id, projectId].every(value => mongoose.isObjectIdOrHexString(value))) throw roleError(400, "Invalid role or project ID");
    const role = await WorkPosition.findById(id).select("category").lean();
    if (!role) throw roleError(404, "Role not found");
    const project = await Project.findOneAndUpdate({
      _id: projectId, status: "draft", assignedTo: null,
      $or: [{ workPositionId: id }, { workPositionId: null, category: role.category }],
    }, { $set: { status: "open", workPositionId: id } }, { new: true });
    if (!project) throw roleError(409, "Only an unassigned draft project belonging to this role can be activated");

    res.json({ ok: true, project, message: "Project activated" });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, message: err.message });
  }
};

/**
 * PATCH_47: PUT /api/admin/workspace/job/:id/credit-worker
 * Credit earnings to a worker who completed work
 */
exports.creditWorker = (_req, res) => res.status(409).json({
  ok: false, message: "Credit earnings from the completed, assigned project so the worker receives a wallet receipt.",
  settlementRoute: "/api/admin/workspace/project/:projectId/credit",
});
