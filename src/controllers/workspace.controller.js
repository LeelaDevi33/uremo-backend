/**
 * PATCH_38/43: Workspace Controller
 * Handles worker status flow, screenings, projects, and earnings
 * PATCH_43: Multi-job support, new worker journey states
 * PATCH_90: Hybrid rubric engine integration
 */
const ApplyWork = require("../models/ApplyWork");
const { createRoleApplication } = require("../services/opportunityApplications");
const roleProjects = require("../services/roleProjects");
const { roleError, revision, withRevision } = require("../services/adminWorkRoles");
const Screening = require("../models/Screening");
const Project = require("../models/Project");
const User = require("../models/User");
const WorkPosition = require("../models/WorkPosition");
const screeningRules = require("../services/applicationScreenings");
const { acquiredProjects } = require("../services/profileProjects");
const { paidProjectAccess } = require("../services/paidProjectAccess");
const {
  runAutoValidation,
  applyScreeningQualityImpact,
} = require("../utils/screeningEngine");

/**
 * PATCH_43: GET /api/workspace/profile
 * Get all user's job applications and their status
 * Supports multi-job with independent status per job
 */
exports.getWorkspaceProfile = async (req, res) => {
  try {
    // PATCH_43: Get ALL job applications for the user (multi-job support)
    const applications = await ApplyWork.find({ user: req.user.id })
      .populate(
        "position",
        "_id title category description trainingMaterials hasScreening screeningId screeningIds",
      )
      .populate("currentProject", "title status payRate payType")
      .sort({ createdAt: -1 })
      .lean();

    if (!applications || applications.length === 0) {
      return res.json({
        hasProfile: false,
        applications: [],
        message: "No workspace profile. Apply to a position to get started.",
      });
    }

    // Enrich each application with screening/project info
    const enrichedApplications = await Promise.all(
      applications.map(async (app) => {
        const requiredScreenings = await screeningRules.requiredSummaries(app.position, app.category);
        const screening = requiredScreenings[0] || null;

        // Get assigned projects for this application
        const assignedProjects = await Project.find({
          assignedTo: req.user.id,
          workPositionId: app.position?._id || null,
          status: { $in: ["assigned", "in_progress"] },
        })
          .select("title description payRate payType deadline status")
          .lean();

        // Get completed projects
        const completedProjects = await Project.find({
          assignedTo: req.user.id,
          workPositionId: app.position?._id || null,
          status: "completed",
        })
          .select("title payRate earningsCredited completedAt")
          .lean();

        // Normalize legacy worker status
        let normalizedStatus = app.workerStatus || "applied";
        if (normalizedStatus === "fresh") normalizedStatus = "applied";
        if (normalizedStatus === "screening_available")
          normalizedStatus = "screening_unlocked";
        if (normalizedStatus === "inactive") normalizedStatus = "suspended";

        return {
          _id: app._id,
          position: app.position,
          positionTitle: app.positionTitle || app.position?.title || "",
          category: app.category || app.position?.category || "",
          workerStatus: normalizedStatus,
          applicationStatus: app.status, // pending/approved/rejected
          attemptCount: app.attemptCount || 0,
          maxAttempts: app.maxAttempts || 2,
          totalEarnings: app.totalEarnings || 0,
          pendingEarnings: app.pendingEarnings || 0,
          payRate: app.payRate || 0,
          screening,
          requiredScreenings,
          trainingMaterials: app.position?.trainingMaterials || [],
          assignedProjects,
          completedProjects,
          screeningsCompleted: app.screeningsCompleted || [],
          createdAt: app.createdAt,
        };
      }),
    );

    // Calculate aggregate stats
    const workEarnings = enrichedApplications.reduce(
      (sum, a) => sum + (a.totalEarnings || 0),
      0,
    );
    const pendingEarnings = enrichedApplications.reduce(
      (sum, a) => sum + (a.pendingEarnings || 0),
      0,
    );
    const projectsCompleted = enrichedApplications.reduce(
      (sum, a) => sum + a.completedProjects.length,
      0,
    );

    // PATCH_76: Include affiliate earnings from User model
    const userDoc = await User.findById(req.user.id).select(
      "totalAffiliateEarned affiliateBalance",
    );
    const affiliateEarnings = userDoc?.totalAffiliateEarned || 0;
    const totalEarnings = workEarnings + affiliateEarnings;

    res.json({
      hasProfile: true,
      applications: enrichedApplications,
      stats: {
        totalEarnings,
        workEarnings,
        affiliateEarnings,
        pendingEarnings,
        projectsCompleted,
        jobsApplied: enrichedApplications.length,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_43: GET /api/workspace/apply/:jobId
 * Apply to a specific job role
 */
exports.applyToJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { resumeUrl, message } = req.body;

    // Check if job exists
    const job = await WorkPosition.findById(jobId).lean();
    if (!job) {
      return res.status(404).json({ message: "Job role not found" });
    }

    if (!job.active) {
      return res.status(400).json({ message: "This position is not active" });
    }

    const application = await createRoleApplication({
      user: req.user.id,
      position: jobId,
      positionTitle: job.title,
      category: job.category,
      resumeUrl: resumeUrl || "",
      message: message || "",
      status: "pending",
      workerStatus: "applied",
    });

    res.status(201).json({
      ok: true,
      message: "Application submitted successfully",
      application,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

/**
 * PATCH_49: PUT /api/workspace/application/:appId/mark-training-viewed
 * Mark that the worker has viewed all training materials
 */
exports.markTrainingViewed = async (req, res) => {
  try {
    const { appId } = req.params;

    const application = await ApplyWork.findOne({
      _id: appId,
      user: req.user.id,
    });

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Only allow when status is screening_unlocked
    if (application.status !== "approved" || !["screening_unlocked", "screening_available"].includes(application.workerStatus)) {
      return res.status(400).json({
        message:
          "Training can only be marked as viewed when screening is unlocked",
      });
    }

    // Update status to training_viewed
    screeningRules.guardScreeningSave(application);
    application.workerStatus = "training_viewed";
    application.trainingViewedAt = new Date();
    await application.save();

    res.json({
      ok: true,
      message:
        "Training marked as viewed. You can now take the screening test.",
      workerStatus: application.workerStatus,
    });
  } catch (err) {
    const status = screeningRules.screeningErrorStatus(err);
    res.status(status).json({ message: status === 409 ? "The screening changed. Refresh your application." : err.message });
  }
};

/**
 * GET /api/workspace/screenings
 * Get available screenings for the worker's category
 */
exports.getAvailableScreenings = async (req, res) => {
  try {
    const profiles = await ApplyWork.find({
      user: req.user.id, status: "approved", workerStatus: { $in: screeningRules.unlocked },
    }).populate("position", screeningRules.roleFields);
    const screenings = new Map();
    for (const profile of profiles) {
      if (!profile.position && profile.populated("position")) continue;
      for (const screening of await screeningRules.requiredSummaries(profile.position, profile.category)) {
        if (!screening.active) continue;
        const id = String(screening._id);
        const record = profile.screeningsCompleted.find(result => String(result.screeningId) === id && screeningRules.passedScreening(result));
        if (!screenings.has(id) || record) screenings.set(id, {
          ...screening, completed: Boolean(record), completedAt: record?.completedAt,
        });
      }
    }
    res.json({ screenings: [...screenings.values()] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/workspace/screening/:id
 * Get a specific screening with questions (for taking)
 */
exports.getScreening = async (req, res) => {
  try {
    if (!Screening.base.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: "Screening not found" });
    const screening = await Screening.findOne({ _id: req.params.id, active: true })
      .select("-questions.correctAnswer -questions.correctAnswers").lean();
    if (!screening) return res.status(404).json({ message: "Screening not found" });
    await screeningRules.eligibleApplication(req.user.id, screening._id, req.query.positionId);
    res.json({ screening });
  } catch (err) {
    const status = screeningRules.screeningErrorStatus(err);
    res.status(status).json({ message: status === 409 ? "The screening changed. Refresh your application." : err.message });
  }
};

/**
 * PATCH_43 + PATCH_90: POST /api/workspace/screening/:id/submit
 * Submit screening answers with hybrid rubric engine
 * Auto-validation layer → autoScore/autoPass → pending_review for hybrid/manual
 */
exports.submitScreening = async (req, res) => {
  try {
    const { answers, positionId } = req.body;
    if (!Screening.base.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: "Screening not found" });
    const screening = await Screening.findOne({ _id: req.params.id, active: true }).lean();
    if (!screening) return res.status(404).json({ message: "Screening not found" });
    const { profile, ids } = await screeningRules.eligibleApplication(req.user.id, screening._id, positionId);
    if (!Array.isArray(answers) || answers.length !== screening.questions.length || !answers.length) {
      return res.status(400).json({ message: "Provide an answer entry for each screening question." });
    }
    screeningRules.guardScreeningSave(profile);
    // PATCH_90: Run hybrid auto-validation engine
    const {
      autoScore,
      autoPass,
      validationFlags,
      rubricBreakdown,
      submissionStatus,
    } = runAutoValidation(screening, answers);

    // Use autoScore as the displayed score
    const score = autoScore;
    const evaluationMode = screening.evaluationMode || "hybrid";

    // PATCH_43: Update attempt count
    profile.attemptCount = (profile.attemptCount || 0) + 1;
    const maxAttempts = profile.maxAttempts || 2;

    // Build screening completion record
    profile.screeningsCompleted = profile.screeningsCompleted || [];
    const completionRecord = {
      screeningId: screening._id,
      completedAt: new Date(),
      score,
      passed: null, // will be set below
      autoScore,
      autoPass,
      submissionStatus,
      rubricBreakdown,
      validationFlags,
      adminReviewedBy: null,
      adminReviewedAt: null,
      adminScore: null,
      answers: answers,
    };

    profile.screeningsCompleted.push(completionRecord);
    const submission = profile.screeningsCompleted[profile.screeningsCompleted.length - 1];
    if (evaluationMode === "auto") {
      submission.passed = autoPass;
      submission.submissionStatus = autoPass ? "approved" : "auto_graded";
      if (autoPass) {
        profile.workerStatus = screeningRules.afterPassing(profile, ids);

        // PATCH_90: Apply quality score impact on auto-pass
        applyScreeningQualityImpact(profile, autoScore);
      } else {
        if (profile.attemptCount < maxAttempts) {
          profile.workerStatus = "screening_unlocked";
        } else {
          profile.workerStatus = "failed";
        }
      }
    } else {
      // hybrid or manual: DO NOT advance worker status
      // Leave as test_submitted → admin must review
      submission.passed = null;
      submission.submissionStatus = "pending_review";
      profile.workerStatus = "test_submitted";
    }
    await profile.save();

    // Build response message
    let message;
    if (evaluationMode === "auto") {
      if (autoPass) {
        message = profile.workerStatus === "ready_to_work" ? "You passed all required screenings and are ready to work." : "You passed this screening. Complete the remaining role screenings.";
      } else if (profile.attemptCount < maxAttempts) {
        message = `You scored ${score}%. You have ${maxAttempts - profile.attemptCount} attempt(s) remaining.`;
      } else {
        message = `You scored ${score}%. You've used all ${maxAttempts} attempts.`;
      }
    } else {
      // hybrid/manual
      if (autoPass) {
        message = `Auto criteria met (${score}%) — pending admin approval.`;
      } else {
        message = `Below rubric threshold (${score}%) — awaiting admin review.`;
      }
    }

    res.json({
      success: true,
      score,
      autoScore,
      autoPass,
      evaluationMode,
      submissionStatus: submission.submissionStatus,
      passed: submission.passed,
      attemptsUsed: profile.attemptCount,
      attemptsRemaining: Math.max(0, maxAttempts - profile.attemptCount),
      newStatus: profile.workerStatus,
      validationFlags,
      rubricBreakdown,
      message,
    });
  } catch (err) {
    const status = screeningRules.screeningErrorStatus(err);
    res.status(status).json({ message: status === 409 ? "The screening changed. Refresh your application." : err.message });
  }
};

/**
 * GET /api/workspace/projects
 * Get worker's assigned projects
 */
exports.getMyProjects = async (req, res) => {
  try {
    const projects = await Project.find({
      assignedTo: req.user.id,
    })
      .sort({ createdAt: -1 })
      .lean();

    const states = await paidProjectAccess(null, projects.map(p => p._id));
    res.set("Cache-Control", "private, no-store").json({
      projects: projects.filter(p => !states.get(String(p._id))?.required),
      acquiredProjects: await acquiredProjects(req.user.id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/workspace/project/:id
 * Get a specific project details
 */
exports.getProject = async (req, res) => {
  try {
    if (!require("mongoose").isObjectIdOrHexString(req.params.id)) return res.status(404).json({ message: "Project not found" });
    res.set("Cache-Control", "private, no-store");
    const state = (await paidProjectAccess(req.user.id, [req.params.id])).get(req.params.id.toLowerCase());
    if (state?.required) {
      const records = state.active ? await acquiredProjects(req.user.id, req.params.id) : [];
      if (!records.length) return res.status(404).json({ message: "No active project access in this profile." });
      return res.json({ acquiredProject: records[0] });
    }
    const project = await Project.findOne({
      _id: req.params.id,
      assignedTo: req.user.id,
    })
      .populate(
        "datasetId",
        "name datasetType difficultyLevel minJustificationWords minWordCount allowMultiResponseComparison isActive",
      ) // PATCH_95
      .lean();

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    res.json({ project });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_47: POST /api/workspace/project/:id/start
 * Mark project as in progress
 */
exports.startProject = async (req, res) => {
  try {
    const project = await Project.db.transaction(async session => {
      const record = await Project.findOneAndUpdate({ _id: req.params.id, assignedTo: req.user.id, status: "assigned" },
        { $set: { status: "in_progress" } }, { session, new: true });
      if (!record) return null;
      await ApplyWork.updateOne({ user: req.user.id, currentProject: record._id }, { $set: { workerStatus: "working" } }, { session });
      return record;
    });
    if (!project) return res.status(409).json({ message: "Only a project assigned to you can be started" });

    res.json({
      success: true,
      message: "Project started! You're now working on it.",
      project,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/workspace/project/:id/submit
 * Submit project completion
 */
exports.submitProject = async (req, res) => {
  try {
    const project = await Project.findOneAndUpdate({ _id: req.params.id, assignedTo: req.user.id, status: { $in: ["assigned", "in_progress"] } },
      { $set: { status: "completed", completedAt: new Date(), completionNotes: req.body.completionNotes } }, { new: true });
    if (!project) return res.status(409).json({ message: "Only an active project assigned to you can be submitted" });

    res.json({
      success: true,
      message:
        "Project submitted for review. Earnings will be credited after admin approval.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/workspace/earnings
 * Get worker's earnings summary
 */
exports.getEarnings = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("walletBalance withdrawable pendingWithdrawals lifetimeEarnings").lean();
    const profile = await ApplyWork.findOne({ user: req.user.id }).select("payRate pendingEarnings totalEarnings").lean();
    const { availableFunds } = require("../services/walletFunds");

    // Get completed projects with earnings
    const completedProjects = await Project.find({
      assignedTo: req.user.id,
      status: "completed",
      earningsCredited: { $gt: 0 },
    })
      .select("title earningsCredited creditedAt")
      .sort({ creditedAt: -1 })
      .lean();

    res.json({
      totalEarnings: Math.max(user?.lifetimeEarnings || 0, profile?.totalEarnings || 0),
      pendingEarnings: profile?.pendingEarnings || 0,
      withdrawable: user ? availableFunds(user).withdrawable : 0,
      payRate: profile?.payRate || 0,
      history: completedProjects.map((p) => ({
        projectId: p._id,
        title: p.title,
        amount: p.earningsCredited,
        creditedAt: p.creditedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/workspace/withdraw
 * Request earnings withdrawal
 */
// Project earnings are already credited to the wallet when awarded. Both
// withdrawal entry points must reserve those same dollars for review.
exports.requestWithdrawal = require("./wallet.controller").requestWithdrawal;

// ============ ADMIN ENDPOINTS ============

/**
 * GET /api/admin/workspace/workers
 * Get all workers with their status
 * PATCH_49: Enhanced with additional counts for dashboard
 */
exports.adminGetWorkers = async (req, res) => {
  try {
    const { status, workerStatus, category, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (workerStatus) filter.workerStatus = workerStatus;
    if (category) filter.category = category;

    const total = await ApplyWork.countDocuments(filter);
    const workers = await ApplyWork.find(filter)
      .populate("user", "name email firstName lastName")
      .populate("position", "title category")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // PATCH_49: Get additional counts for dashboard
    const pendingCount = await ApplyWork.countDocuments({ status: "pending" });
    const waitingScreeningCount = await ApplyWork.countDocuments({
      workerStatus: "screening_unlocked",
    });
    const readyToWorkCount = await ApplyWork.countDocuments({
      workerStatus: "ready_to_work",
    });
    const activeCount = await ApplyWork.countDocuments({
      workerStatus: { $in: ["assigned", "working"] },
    });

    // PATCH_90: Transform workers to include proper userId structure with firstName/lastName
    const transformedWorkers = workers.map((w) => {
      // Handle user name - multiple strategies for robustness
      let firstName = "";
      let lastName = "";
      let email = w.user?.email || "";
      let fullName = "";

      if (w.user) {
        // Strategy 1: Use existing firstName/lastName if available
        if (w.user.firstName || w.user.lastName) {
          firstName = w.user.firstName || "";
          lastName = w.user.lastName || "";
          fullName = `${firstName} ${lastName}`.trim();
        }
        // Strategy 2: Split name field if available
        else if (w.user.name && w.user.name.trim()) {
          const nameParts = w.user.name.trim().split(" ");
          firstName = nameParts[0] || "";
          lastName = nameParts.slice(1).join(" ") || "";
          fullName = w.user.name.trim();
        }
        // Strategy 3: Use email username as firstName
        else if (email) {
          firstName = email.split("@")[0];
          fullName = firstName;
        }
      }

      return {
        ...w,
        userId: w.user
          ? {
              _id: w.user._id,
              firstName: firstName,
              lastName: lastName,
              email: email,
              name: fullName || firstName || email || "Unknown", // Include consolidated name
            }
          : {
              _id: null,
              firstName: "Unknown",
              lastName: "Worker",
              email: "No email",
              name: "Unknown Worker",
            },
        jobId: w.position
          ? {
              _id: w.position._id,
              title: w.position.title,
              category: w.position.category,
            }
          : null,
        positionTitle: w.position?.title || w.positionTitle || "No Position",
      };
    });

    res.json({
      workers: transformedWorkers,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      // PATCH_49: Additional counts
      pendingCount,
      waitingScreeningCount,
      readyToWorkCount,
      activeCount,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_62: GET /api/admin/workspace/workers/qualified-count
 * Get count of qualified workers (ready_to_work) per category
 * Used by Master Workspace to determine if projects can be created
 */
exports.adminGetQualifiedWorkerCounts = async (req, res) => {
  try {
    // Aggregate workers with ready_to_work status grouped by category
    const pipeline = [
      {
        $match: {
          workerStatus: "ready_to_work",
          category: { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
        },
      },
    ];

    const results = await ApplyWork.aggregate(pipeline);

    // Convert to object { category: count }
    const qualifiedCounts = {};
    results.forEach((r) => {
      qualifiedCounts[r._id] = r.count;
    });

    // Include all defined categories with 0 defaults
    const categories = [
      "microjobs",
      "writing",
      "teaching",
      "coding_math",
      "outlier",
      "other",
    ];
    categories.forEach((cat) => {
      if (!(cat in qualifiedCounts)) {
        qualifiedCounts[cat] = 0;
      }
    });

    res.json({
      qualifiedCounts,
      total: results.reduce((sum, r) => sum + r.count, 0),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_61: GET /api/admin/workspace/worker/:id
 * Get single worker with full details for Worker 360 page
 */
exports.adminGetWorkerById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!ApplyWork.base.isObjectIdOrHexString(id)) return res.status(404).json({ message: "Worker not found" });
    // Older operator links used account IDs. The current link identifies a
    // specific application even when the account has several specializations.
    const detail = query => query.populate("user", "firstName lastName name email phone avatar createdAt")
      .populate("position", "title category description payRate").lean();
    const worker = await detail(ApplyWork.findById(id)) ||
      await detail(ApplyWork.findOne({ user: id }).sort({ createdAt: -1, _id: -1 }));

    if (!worker) {
      return res.status(404).json({ message: "Worker not found" });
    }

    // Get all projects assigned to this worker
    const projects = worker.user ? await Project.find({ assignedTo: worker.user._id })
      .sort({ createdAt: -1 })
      .lean() : [];

    // Get all applications for this user
    const applications = worker.user ? await ApplyWork.find({ user: worker.user._id })
      .populate("position", "title category")
      .sort({ createdAt: -1 })
      .lean() : [worker];

    // Build activity log
    const activityLog = [];

    // Application events
    applications.forEach((app) => {
      activityLog.push({
        type: "application_created",
        description: `Applied for ${app.position?.title || app.positionTitle || "Unknown Position"}`,
        timestamp: app.createdAt,
      });

      if (app.trainingViewedAt) {
        activityLog.push({
          type: "training_viewed",
          description: "Viewed training materials",
          timestamp: app.trainingViewedAt,
        });
      }

      if (app.screeningsCompleted && app.screeningsCompleted.length > 0) {
        app.screeningsCompleted.forEach((s) => {
          activityLog.push({
            type: "screening_completed",
            description: `Completed screening with score ${s.score}%`,
            timestamp: s.completedAt,
          });
        });
      }

      if (app.testsCompleted && app.testsCompleted.length > 0) {
        app.testsCompleted.forEach((t) => {
          activityLog.push({
            type: t.passed ? "test_passed" : "test_failed",
            description: `${t.passed ? "Passed" : "Failed"} test with score ${t.score}%`,
            timestamp: t.completedAt,
          });
        });
      }
    });

    // Project events
    projects.forEach((p) => {
      if (p.assignedAt) {
        activityLog.push({
          type: "project_assigned",
          description: `Assigned to project: ${p.title}`,
          timestamp: p.assignedAt,
        });
      }
      if (p.completedAt) {
        activityLog.push({
          type: "project_completed",
          description: `Completed project: ${p.title}`,
          timestamp: p.completedAt,
        });
      }
    });

    // Sort activity log by timestamp
    activityLog.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      worker: {
        ...worker,
        projects,
        allApplications: applications,
        activityLog,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/worker/:id/status
 * Update worker status
 * PATCH_87: State machine validation - only allow valid transitions
 */
exports.adminUpdateWorkerStatus = async (req, res) => {
  try {
    const { workerStatus, payRate, adminNotes, forceOverride } = req.body;

    // PATCH_87: Define valid state transitions
    const ALLOWED_TRANSITIONS = {
      applied: ["screening_unlocked", "suspended"],
      screening_unlocked: [
        "training_viewed",
        "test_submitted",
        "ready_to_work",
        "suspended",
      ],
      training_viewed: ["test_submitted", "ready_to_work", "suspended"],
      test_submitted: [
        "ready_to_work",
        "screening_unlocked",
        "failed",
        "suspended",
      ],
      failed: ["screening_unlocked", "suspended"], // retry allowed
      ready_to_work: ["assigned", "suspended"],
      assigned: ["working", "ready_to_work", "suspended"],
      working: ["ready_to_work", "suspended"],
      suspended: ["ready_to_work", "screening_unlocked", "applied"],
    };

    // First, get the current worker state
    const worker = await ApplyWork.findById(req.params.id);
    if (!worker) {
      return res.status(404).json({ message: "Worker not found" });
    }

    // PATCH_87: Validate state transition (unless forceOverride is set)
    if (workerStatus && workerStatus !== worker.workerStatus) {
      const currentStatus = worker.workerStatus || "applied";
      const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];

      if (!allowedNext.includes(workerStatus) && !forceOverride) {
        return res.status(400).json({
          message: `Invalid transition: ${currentStatus} → ${workerStatus}. Allowed: ${allowedNext.join(", ")}`,
          currentStatus,
          requestedStatus: workerStatus,
          allowedTransitions: allowedNext,
          hint: "Use forceOverride=true to bypass (admin only)",
        });
      }

      // Log if using force override
      if (forceOverride && !allowedNext.includes(workerStatus)) {
        console.log(
          `[PATCH_87] ADMIN OVERRIDE: ${currentStatus} → ${workerStatus} by admin ${req.user.id}`,
        );
      }
    }

    const update = {};
    if (workerStatus) update.workerStatus = workerStatus;
    if (payRate !== undefined) update.payRate = payRate;
    if (adminNotes !== undefined) update.adminNotes = adminNotes;

    if (workerStatus === "ready_to_work") {
      update.approvedBy = req.user.id;
      update.approvedAt = new Date();
    }

    const updatedWorker = await ApplyWork.findByIdAndUpdate(
      req.params.id,
      update,
      {
        new: true,
      },
    ).populate("user", "name email");

    res.json({ success: true, worker: updatedWorker });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const normalizeScreeningQuestions = (questions = []) => {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => {
    const options = Array.isArray(q.options) ? q.options : [];
    let correctAnswers = [];

    if (Array.isArray(q.correctAnswers)) {
      correctAnswers = q.correctAnswers.map(String).filter(Boolean);
    } else if (q.correctAnswer !== undefined && q.correctAnswer !== null) {
      if (typeof q.correctAnswer === "number") {
        const opt = options[q.correctAnswer];
        if (opt) correctAnswers = [String(opt)];
      } else {
        correctAnswers = [String(q.correctAnswer)];
      }
    }

    return {
      question: q.question,
      type: q.type || "single",
      options,
      correctAnswer: q.correctAnswer,
      correctAnswers,
      points: q.points || 1,
      // PATCH_94: RLHF question fields
      responseA: q.responseA || undefined,
      responseB: q.responseB || undefined,
      imageUrl: q.imageUrl || undefined,
      codeLanguage: q.codeLanguage || undefined,
      referenceUrls: q.referenceUrls || undefined,
      minWords: q.minWords || undefined,
    };
  });
};

/**
 * POST /api/admin/workspace/screenings
 * Create a new screening
 * PATCH-64: Enhanced with validation guardrails
 */
exports.adminCreateScreening = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");

    const {
      title,
      description,
      category,
      trainingMaterials,
      questions,
      passingScore,
      timeLimit,
      // PATCH_90: Hybrid rubric fields
      evaluationMode,
      rubric,
      passThreshold,
      autoValidationRules,
      // PATCH_94: RLHF fields
      screeningType,
      minJustificationWords,
      allowRanking,
      allowMultiResponseComparison,
    } = req.body;

    // PATCH-64 GUARDRAIL: Title required
    if (!title || title.trim().length < 3) {
      return res.status(400).json({
        message: "Screening title is required (minimum 3 characters)",
      });
    }

    // PATCH-64 GUARDRAIL: Category required
    if (!category) {
      return res.status(400).json({
        message: "Category is required for screening",
      });
    }

    // PATCH-64 GUARDRAIL: Questions required - cannot save empty screening
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        message: "Screening must have at least 1 question",
        hint: "Add questions before saving the screening",
      });
    }

    // PATCH-64 GUARDRAIL: Validate each question has required fields
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question || q.question.trim().length < 5) {
        return res.status(400).json({
          message: `Question ${i + 1} text is missing or too short`,
        });
      }
      // PATCH_94: RLHF question types don't require options
      const rlhfTypes = [
        "text",
        "file_upload",
        "ranking",
        "written",
        "red_team",
        "fact_check",
        "coding",
        "multimodal",
      ];
      if (!rlhfTypes.includes(q.type)) {
        if (!q.options || q.options.length < 2) {
          return res.status(400).json({
            message: `Question ${i + 1} must have at least 2 options`,
          });
        }
      }
    }

    const screening = await Screening.create({
      title,
      description,
      category,
      trainingMaterials,
      questions: normalizeScreeningQuestions(questions),
      passingScore,
      timeLimit,
      // PATCH_90: Hybrid rubric fields
      evaluationMode: evaluationMode || "hybrid",
      rubric: rubric || [],
      passThreshold: passThreshold || passingScore || 70,
      autoValidationRules: autoValidationRules || {},
      // PATCH_94: RLHF fields
      screeningType: screeningType || "mcq",
      minJustificationWords: minJustificationWords || 0,
      allowRanking: allowRanking || false,
      allowMultiResponseComparison: allowMultiResponseComparison || false,
      createdBy: req.user.id,
    });

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: "screening_create",
      entityType: "screening",
      entityId: String(screening._id),
      previousState: null,
      newState: { title, category, questionCount: questions.length },
      reason: `Created screening: ${title}`,
    });

    res.status(201).json({ success: true, screening });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/admin/workspace/screenings
 * Get all screenings
 */
exports.adminGetScreenings = async (req, res) => {
  try {
    const screenings = await Screening.find().sort({ createdAt: -1 }).lean();

    res.json({ screenings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/admin/workspace/screenings/:id
 * Get a single screening
 */
exports.adminGetScreeningById = async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).lean();
    if (!screening) {
      return res.status(404).json({ message: "Screening not found" });
    }
    res.json({ screening });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/screenings/:id
 * Update a screening
 */
exports.adminUpdateScreening = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      trainingMaterials,
      questions,
      passingScore,
      timeLimit,
      active,
      // PATCH_90: Hybrid rubric fields
      evaluationMode,
      rubric,
      passThreshold,
      autoValidationRules,
      // PATCH_94: RLHF fields
      screeningType,
      minJustificationWords,
      allowRanking,
      allowMultiResponseComparison,
    } = req.body;

    const updateData = {
      title,
      description,
      category,
      trainingMaterials,
      questions: normalizeScreeningQuestions(questions),
      passingScore,
      timeLimit,
      active,
    };
    // PATCH_90: Include hybrid rubric fields if provided
    if (evaluationMode !== undefined)
      updateData.evaluationMode = evaluationMode;
    if (rubric !== undefined) updateData.rubric = rubric;
    if (passThreshold !== undefined) updateData.passThreshold = passThreshold;
    if (autoValidationRules !== undefined)
      updateData.autoValidationRules = autoValidationRules;
    // PATCH_94: RLHF fields
    if (screeningType !== undefined) updateData.screeningType = screeningType;
    if (minJustificationWords !== undefined)
      updateData.minJustificationWords = minJustificationWords;
    if (allowRanking !== undefined) updateData.allowRanking = allowRanking;
    if (allowMultiResponseComparison !== undefined)
      updateData.allowMultiResponseComparison = allowMultiResponseComparison;

    const screening = await Screening.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true },
    );

    if (!screening) {
      return res.status(404).json({ message: "Screening not found" });
    }

    res.json({ success: true, screening });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/admin/workspace/screenings/:id/clone
 * Duplicate a screening
 */
exports.adminCloneScreening = async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).lean();
    if (!screening) {
      return res.status(404).json({ message: "Screening not found" });
    }

    const cloned = await Screening.create({
      title: `Copy of ${screening.title}`,
      description: screening.description,
      category: screening.category,
      trainingMaterials: screening.trainingMaterials || [],
      questions: normalizeScreeningQuestions(screening.questions || []),
      passingScore: screening.passingScore,
      timeLimit: screening.timeLimit,
      active: screening.active,
      // PATCH_94: Carry RLHF fields on clone
      screeningType: screening.screeningType || "mcq",
      minJustificationWords: screening.minJustificationWords || 0,
      allowRanking: screening.allowRanking || false,
      allowMultiResponseComparison:
        screening.allowMultiResponseComparison || false,
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, screening: cloned });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/admin/workspace/screenings/:id
 * Delete a screening
 */
exports.adminDeleteScreening = async (req, res) => {
  try {
    const deleted = await Screening.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Screening not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/admin/workspace/projects
 * Create a new project
 * PATCH_90: GET /api/admin/workspace/screening-submissions
 * Get all pending screening submissions for admin review
 */
exports.adminGetScreeningSubmissions = async (req, res) => {
  try {
    const { status } = req.query;
    const filterStatus = status || "pending_review";

    // Find all workers with screeningsCompleted entries matching the filter status
    const workers = await ApplyWork.find({
      "screeningsCompleted.submissionStatus": filterStatus,
    })
      .populate("user", "name email")
      .populate("position", "title category")
      .lean();

    const submissions = [];
    for (const worker of workers) {
      for (const sc of worker.screeningsCompleted || []) {
        if (sc.submissionStatus === filterStatus) {
          // Load screening details
          const screening = await Screening.findById(sc.screeningId)
            .select(
              "title category evaluationMode rubric passThreshold questions",
            )
            .lean();

          submissions.push({
            workerId: worker._id,
            userId: worker.user?._id,
            workerName: worker.user?.name || "Unknown",
            workerEmail: worker.user?.email || "",
            positionTitle: worker.position?.title || worker.positionTitle || "",
            positionCategory:
              worker.position?.category || worker.category || "",
            workerStatus: worker.workerStatus,
            screeningId: sc.screeningId,
            screeningTitle: screening?.title || "Unknown Screening",
            evaluationMode: screening?.evaluationMode || "hybrid",
            completedAt: sc.completedAt,
            score: sc.score,
            autoScore: sc.autoScore,
            autoPass: sc.autoPass,
            submissionStatus: sc.submissionStatus,
            rubricBreakdown: sc.rubricBreakdown || [],
            validationFlags: sc.validationFlags || [],
            adminScore: sc.adminScore,
            answers: sc.answers,
            screeningQuestions: (screening?.questions || []).map((q) => ({
              question: q.question,
              type: q.type,
              options: q.options,
              points: q.points,
            })),
            rubricTemplate: screening?.rubric || [],
            passThreshold: screening?.passThreshold || 70,
            _submissionIndex: (worker.screeningsCompleted || []).indexOf(sc),
          });
        }
      }
    }

    // Sort by completedAt desc
    submissions.sort(
      (a, b) => new Date(b.completedAt) - new Date(a.completedAt),
    );

    res.json({ success: true, submissions, count: submissions.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_90: POST /api/admin/workspace/screening-submissions/:workerId/review
 * Admin reviews a screening submission (approve/reject)
 */
exports.adminReviewScreeningSubmission = async (req, res) => {
  try {
    const { workerId } = req.params;
    const { screeningId, action, adminScore, rubricBreakdown } = req.body;
    // action: "approve" | "reject"

    // PATCH_90: Validate ObjectId format
    const mongoose = require("mongoose");
    if (!mongoose.Types.ObjectId.isValid(workerId)) {
      return res.status(400).json({ message: "Invalid worker ID format" });
    }
    if (!screeningId || !mongoose.Types.ObjectId.isValid(screeningId)) {
      return res
        .status(400)
        .json({ message: "Invalid or missing screening ID" });
    }

    if (!["approve", "reject"].includes(action)) {
      return res
        .status(400)
        .json({ message: "Invalid action. Use 'approve' or 'reject'." });
    }

    const profile = await ApplyWork.findById(workerId);
    if (!profile) {
      return res.status(404).json({ message: "Worker not found" });
    }

    // Find the specific screening submission
    const submission = (profile.screeningsCompleted || []).find(
      (sc) =>
        sc.screeningId?.toString() === screeningId &&
        sc.submissionStatus === "pending_review",
    );

    if (!submission) {
      return res.status(404).json({
        message: "No pending screening submission found for this screening",
      });
    }

    if (profile.status !== "approved" || !["test_submitted", "screening_unlocked", "training_viewed", "screening_available"].includes(profile.workerStatus)) {
      return res.status(409).json({ message: "The application is no longer available for screening review." });
    }
    const role = profile.position ? await WorkPosition.findById(profile.position).select(screeningRules.roleFields).lean() : null;
    const required = await screeningRules.requiredScreeningIds(role, profile.category);
    if ((profile.position && !role) || !required.includes(String(submission.screeningId))) {
      return res.status(409).json({ message: "This screening is no longer assigned to the application." });
    }
    screeningRules.guardScreeningSave(profile);
    submission.adminReviewedBy = req.user.id;
    submission.adminReviewedAt = new Date();

    if (adminScore !== undefined && adminScore !== null) {
      submission.adminScore = adminScore;
    }

    if (rubricBreakdown && Array.isArray(rubricBreakdown)) {
      submission.rubricBreakdown = rubricBreakdown;
    }

    if (action === "approve") {
      submission.submissionStatus = "approved";
      submission.passed = true;

      // PATCH_90: Apply quality score impact
      applyScreeningQualityImpact(
        profile,
        submission.autoScore || submission.score || 0,
      );

      profile.workerStatus = screeningRules.afterPassing(profile, required);
      if (profile.workerStatus === "ready_to_work") {
        profile.approvedBy = req.user.id;
        profile.approvedAt = new Date();
      }
    } else {
      // reject
      submission.submissionStatus = "rejected";
      submission.passed = false;

      const maxAttempts = profile.maxAttempts || 2;
      if (profile.attemptCount < maxAttempts) {
        profile.workerStatus = "screening_unlocked";
      } else {
        profile.workerStatus = "failed";
      }
    }

    await profile.save();

    // Audit log
    try {
      const { logAdminAction } = require("../services/adminAudit.service");
      await logAdminAction({
        adminId: req.user?._id || req.user?.id,
        adminEmail: req.user?.email,
        action: action === "approve" ? "worker_approve" : "worker_reject",
        entityType: "worker",
        entityId: String(profile._id),
        previousState: { submissionStatus: "pending_review" },
        newState: {
          submissionStatus: submission.submissionStatus,
          workerStatus: profile.workerStatus,
          qualityScore: profile.qualityScore,
          tier: profile.tier,
        },
        reason: `Screening submission ${action}d`,
      });
    } catch (auditErr) {
      console.error("Audit log failed:", auditErr.message);
    }

    res.json({
      success: true,
      action,
      workerStatus: profile.workerStatus,
      qualityScore: profile.qualityScore,
      tier: profile.tier,
      submissionStatus: submission.submissionStatus,
    });
  } catch (err) {
    const status = screeningRules.screeningErrorStatus(err);
    res.status(status).json({ message: status === 409 ? "The screening changed. Refresh your application." : err.message });
  }
};

/**
 * PATCH_86: Projects MUST be linked to a Job Role
 */
exports.adminCreateProject = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      instructions,
      deliverables,
      payRate,
      payType,
      estimatedTasks,
      deadline,
      screeningId,
      screeningIds, // PATCH_88: Multiple screenings
      earnings,
      priority,
      workPositionId, // PATCH_86: Job Role ID
      projectType, // PATCH_95: standard | rlhf_dataset
      datasetId, // PATCH_95: linked dataset
      rewardPerTask, // PATCH_95: per-task reward
    } = req.body;

    const project = await roleProjects.createForRole({
      title,
      description,
      category,
      instructions,
      deliverables,
      payRate: payRate || earnings || 0,
      payType,
      estimatedTasks,
      deadline,
      status: "open",
      createdBy: req.user.id,
      screeningId: screeningId || undefined,
      screeningIds: screeningIds || [], // PATCH_88: Multiple screenings
      workPositionId: workPositionId || undefined, // PATCH_86
      priority: priority || "medium",
      projectType: projectType || "standard", // PATCH_95
      datasetId: projectType === "rlhf_dataset" ? datasetId : undefined, // PATCH_95
      rewardPerTask: rewardPerTask || 0, // PATCH_95
    });

    // PATCH_58: Notify ready workers about new project
    try {
      const {
        notifyReadyWorkers,
      } = require("../services/smartEngagement.service");
      await notifyReadyWorkers(title, category, project._id.toString());
    } catch (engErr) {
      console.warn(
        "[WORKSPACE] Engagement notification failed:",
        engErr.message,
      );
    }

    res.status(201).json({ success: true, project });
  } catch (err) {
    res.status(err.status || (["CastError", "ValidationError"].includes(err.name) ? 400 : 500)).json({ message: err.message });
  }
};

/**
 * GET /api/admin/workspace/projects
 * Get all projects
 * PATCH_86: Include job role info
 */
exports.adminGetProjects = async (req, res) => {
  try {
    const { status, category, workPositionId } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (workPositionId) filter.workPositionId = workPositionId; // PATCH_86

    const projects = await Project.find(filter)
      .populate("assignedTo", "name email firstName lastName")
      .populate("workPositionId", "title category hasScreening") // PATCH_86
      .populate("screeningId", "title passingScore")
      .populate("screeningIds", "title passingScore") // PATCH_88
      .populate("datasetId", "name datasetType") // PATCH_95
      .sort({ createdAt: -1 })
      .lean();

    const reserved = await paidProjectAccess(null, projects.map(p => p._id));
    res.json({ projects: projects.map(p => ({ ...withRevision(p), marketplaceReserved: reserved.get(String(p._id))?.required === true })) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/project/:id/assign
 * Assign project to a worker
 * PATCH-64: Enhanced with category matching and guardrails
 * PATCH_86: Enforce job role eligibility - worker must have passed screening
 */
exports.adminAssignProject = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");
    const { workerId } = req.body;

    const { project, worker } = await roleProjects.assign(req.params.id, workerId);
    const previousStatus = "open";
    const workerCategory = worker.category;

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: "project_assign",
      entityType: "project",
      entityId: String(project._id),
      previousState: { status: previousStatus, assignedTo: null },
      newState: { status: "assigned", assignedTo: String(worker.user) },
      reason: `Assigned to worker ${workerId}`,
      metadata: {
        workerId: String(workerId),
        projectCategory: project.category,
        workerCategory,
      },
    });

    res.json({ success: true, project });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/workspace/project/:id/credit
 * Credit earnings for completed project
 */
exports.adminCreditEarnings = async (req, res) => {
  try {
    const { amount, rating } = req.body;

    const creditAmount = typeof amount === "string" ? Number(amount) : amount;
    const project = await roleProjects.creditCompleted(req.params.id, creditAmount, rating);

    res.json({
      success: true,
      message: `$${creditAmount.toFixed(2)} credited to worker`,
      project,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

/**
 * PATCH_61B: POST /api/admin/workspace/workers/:id/assign-task
 * Assign a specialized task to a worker
 */
exports.adminAssignTask = async (req, res) => {
  try {
    const { taskDescription, jobId } = req.body;
    const workerId = req.params.id;

    if (!taskDescription || !taskDescription.trim()) {
      return res.status(400).json({ message: "Task description required" });
    }

    // Find the worker's profile (ApplyWork)
    const workerProfile =
      await ApplyWork.findById(workerId).populate("user position");
    if (!workerProfile) {
      return res.status(404).json({ message: "Worker profile not found" });
    }

    // Create task record (save in a new Task model or add to profile)
    // For now, we'll add to workerProfile and send notification email
    if (!workerProfile.assignedTasks) {
      workerProfile.assignedTasks = [];
    }

    const taskId = require("mongoose").Types.ObjectId();
    workerProfile.assignedTasks.push({
      _id: taskId,
      description: taskDescription,
      assignedAt: new Date(),
      status: "pending", // pending, in-progress, completed
      assignedBy: req.user.id,
    });

    await workerProfile.save();

    // Send notification email to worker
    const user = workerProfile.user;
    if (user && user.email) {
      // TODO: Send email with task details
      // await sendEmail(user.email, "New Task Assigned", `You have been assigned: ${taskDescription}`);
    }

    res.json({
      success: true,
      message: "Task assigned successfully",
      taskId,
      worker: {
        name: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
        email: user?.email,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_65.1: GET /api/admin/workspace/project/:id
 * Get single project by ID with full details
 */
exports.adminGetProjectById = async (req, res) => {
  try {
    if (!Project.base.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ message: "Invalid project ID" });
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });

    // Capture the stored IDs before population. A deleted role must not make
    // an unrelated application for the same person appear to own this work.
    const owner = project.assignedTo, role = project.workPositionId;
    const identity = "name firstName lastName email";
    const roleFields = "title category active";
    await Project.populate(project, [
      { path: "workPositionId", select: roleFields },
      { path: "assignedTo", select: identity }, { path: "createdBy", select: identity },
      { path: "screeningId", select: "title passingScore timeLimit" }, { path: "screeningIds", select: "title passingScore timeLimit" },
      { path: "datasetId", select: "name datasetType difficultyLevel minJustificationWords minWordCount allowMultiResponseComparison isActive" },
    ]);

    let workerProfile = null;
    if (owner) {
      const filter = { user: owner, ...(role ? { position: role } : {}) };
      const exact = await ApplyWork.findOne({ ...filter, $or: [{ currentProject: project._id }, { "projectsCompleted.projectId": project._id }] })
        .sort({ updatedAt: -1 }).lean();
      if (exact) workerProfile = exact;
      else {
        const candidates = await ApplyWork.find(filter).limit(2).lean();
        if (candidates.length === 1) workerProfile = candidates[0];
      }
      if (workerProfile) await ApplyWork.populate(workerProfile, [
        { path: "user", select: identity }, { path: "position", select: roleFields },
      ]);
    }
    const ProofOfWork = require("../models/ProofOfWork");
    const proofs = await ProofOfWork.find({ projectId: project._id })
      .populate("workerId", identity).populate("jobRoleId", roleFields).populate("reviewedBy", identity)
      .sort({ createdAt: -1 }).lean();
    project.marketplaceReserved = (await paidProjectAccess(null, [project._id])).get(String(project._id))?.required === true;

    res.json({
      success: true,
      project: withRevision(project),
      workerProfile,
      proofs,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH_65.1: PUT /api/admin/workspace/project/:id
 * Update project details
 */
exports.adminUpdateProject = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      instructions,
      deliverables,
      payRate,
      payType,
      estimatedTasks,
      deadline,
      status,
      priority,
      screeningId,
      screeningIds, // PATCH_88: Multiple screenings
      projectType, // PATCH_95
      datasetId, // PATCH_95
      rewardPerTask, // PATCH_95
    } = req.body;

    const project = await Project.db.transaction(async session => {
      const record = await projectForEdit(req, session);
      if (category !== undefined && (typeof category !== "string" || !category.trim() || category.trim().length > 48)) {
        throw roleError(400, "A project category of 1 to 48 characters is required");
      }
      if (status !== undefined && status !== record.status) {
        const openInventory = ["draft", "open"].includes(record.status) && !record.assignedTo;
        const cancelAssignment = ["assigned", "in_progress"].includes(record.status) && status === "cancelled";
        if (!(openInventory && ["draft", "open", "cancelled"].includes(status)) && !cancelAssignment) {
          throw roleError(409, "Use the assignment or completion workflow for this project");
        }
        if (cancelAssignment) await ApplyWork.updateOne({ user: record.assignedTo, currentProject: record._id },
          { $set: { currentProject: null, workerStatus: "ready_to_work" } }, { session });
      }
      const previousState = { status: record.status, payRate: record.payRate, payType: record.payType, priority: record.priority };
      const changes = { title, description, category, instructions, deliverables, payRate, payType, estimatedTasks,
        deadline: deadline === "" ? null : deadline, status, priority, screeningId: screeningId === "" ? null : screeningId,
        screeningIds, projectType, datasetId: datasetId === "" ? null : datasetId, rewardPerTask };
      for (const [key, value] of Object.entries(changes)) if (value !== undefined) record.set(key, value);
      record.updatedAt = new Date(Math.max(Date.now(), Date.parse(revision(record)) + 1));
      await record.save({ session, timestamps: false });
      await require("../services/adminAudit.service").logAdminAction({
        adminId: req.user.id, adminEmail: req.user.email, action: "project_update", entityType: "project",
        entityId: String(record._id), previousState,
        newState: { status: record.status, payRate: record.payRate, payType: record.payType, priority: record.priority },
        metadata: { fields: Object.keys(changes).filter(k => changes[k] !== undefined) },
      }, { session, required: true });
      return record;
    });

    res.json({
      success: true,
      message: "Project updated successfully",
      project: withRevision(project),
    });
  } catch (err) {
    res.status(err.status || (err.name === "ValidationError" ? 400 : 500)).json({ message: err.message, code: err.code });
  }
};

/**
 * PATCH_65.1: DELETE /api/admin/workspace/project/:id
 * Delete a project (only if not assigned)
 */
exports.adminDeleteProject = async (req, res) => {
  try {
    await Project.db.transaction(async session => {
      const project = await projectForEdit(req, session);
      if (["assigned", "in_progress", "completed"].includes(project.status)) {
        throw roleError(400, "Assigned and completed projects are kept for history");
      }
      const access = (await paidProjectAccess(null, [project._id], { session })).get(String(project._id));
      if (access?.required) throw roleError(409, "A project linked to a marketplace offer must be kept for its access records.");
      const removed = await Project.findOneAndDelete({ _id: req.params.id, status: { $in: ["draft", "open", "cancelled"] }, assignedTo: null }, { session });
      if (!removed) throw roleError(409, "Assigned or completed projects are kept for history");
      await require("../services/adminAudit.service").logAdminAction({ adminId: req.user.id, adminEmail: req.user.email,
        action: "project_delete", entityType: "project", entityId: String(removed._id), previousState: { title: removed.title, status: removed.status },
      }, { session, required: true });
    });

    res.json({
      success: true,
      message: "Project deleted successfully",
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message, code: err.code });
  }
};

async function projectForEdit(req, session) {
  if (!Project.base.isObjectIdOrHexString(req.params.id)) throw roleError(400, "Invalid project ID");
  const project = await Project.findById(req.params.id).session(session);
  if (!project) throw roleError(404, "Project not found");
  const expected = req.body?.expectedRevision;
  if (expected !== revision(project)) {
    throw Object.assign(roleError(expected === undefined ? 428 : 409, "Reload this project before saving or deleting it."), { code: "STALE_PROJECT" });
  }
  return project;
}

/**
 * PATCH_86: GET /api/admin/workspace/project/:id/eligible-workers
 * Get workers who are eligible to be assigned to this project
 * Based on job role matching and screening completion
 */
exports.adminGetEligibleWorkers = async (req, res) => {
  try {
    // PATCH_92: No-cache headers to prevent stale eligible worker lists
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const project = await Project.findById(req.params.id).populate(
      "workPositionId",
      "screeningId screeningIds hasScreening title category",
    );

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    const workerFilter = { status: "approved", workerStatus: "ready_to_work", currentProject: null };
    if (project.workPositionId) workerFilter.position = project.workPositionId._id;
    const workers = project.status === "open" && !project.assignedTo ?
      await ApplyWork.find(workerFilter)
        .populate("user", "name email firstName lastName")
        .populate("position", "title category screeningId screeningIds hasScreening")
        .select("user position workerStatus screeningsCompleted totalEarnings").lean() : [];
    const eligibleWorkers = workers.filter(worker => roleProjects.meetsScreenings(worker, project, worker.position));

    res.json({
      success: true,
      project: {
        _id: project._id,
        title: project.title,
        category: project.category,
        workPositionId: project.workPositionId,
      },
      workers: eligibleWorkers.map((w) => ({
        _id: w._id,
        userId: w.user,
        position: w.position,
        workerStatus: w.workerStatus,
        totalEarnings: w.totalEarnings || 0,
      })),
      eligibilityInfo: project.workPositionId
        ? {
            jobRole: project.workPositionId.title,
            requiresScreening: project.workPositionId.hasScreening || false,
          }
        : { jobRole: null, requiresScreening: false },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getWorkspaceProfile: exports.getWorkspaceProfile,
  applyToJob: exports.applyToJob,
  markTrainingViewed: exports.markTrainingViewed,
  getAvailableScreenings: exports.getAvailableScreenings,
  getScreening: exports.getScreening,
  submitScreening: exports.submitScreening,
  getMyProjects: exports.getMyProjects,
  getProject: exports.getProject,
  startProject: exports.startProject,
  submitProject: exports.submitProject,
  getEarnings: exports.getEarnings,
  requestWithdrawal: exports.requestWithdrawal,
  adminGetWorkers: exports.adminGetWorkers,
  adminGetQualifiedWorkerCounts: exports.adminGetQualifiedWorkerCounts, // PATCH_62
  adminGetWorkerById: exports.adminGetWorkerById, // PATCH_61
  adminUpdateWorkerStatus: exports.adminUpdateWorkerStatus,
  adminCreateScreening: exports.adminCreateScreening,
  adminGetScreenings: exports.adminGetScreenings,
  adminGetScreeningById: exports.adminGetScreeningById,
  adminUpdateScreening: exports.adminUpdateScreening,
  adminCloneScreening: exports.adminCloneScreening,
  adminDeleteScreening: exports.adminDeleteScreening,
  adminCreateProject: exports.adminCreateProject,
  adminGetProjects: exports.adminGetProjects,
  adminGetProjectById: exports.adminGetProjectById, // PATCH_65.1
  adminUpdateProject: exports.adminUpdateProject, // PATCH_65.1
  adminDeleteProject: exports.adminDeleteProject, // PATCH_65.1
  adminAssignProject: exports.adminAssignProject,
  adminGetEligibleWorkers: exports.adminGetEligibleWorkers, // PATCH_86
  adminCreditEarnings: exports.adminCreditEarnings,
  adminAssignTask: exports.adminAssignTask,
  adminGetScreeningSubmissions: exports.adminGetScreeningSubmissions, // PATCH_90
  adminReviewScreeningSubmission: exports.adminReviewScreeningSubmission, // PATCH_90
};
