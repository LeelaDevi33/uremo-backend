const Dataset = require("../models/Dataset");
const DatasetTask = require("../models/DatasetTask");
const RlhfSubmission = require("../models/RlhfSubmission");
const Project = require("../models/Project");
const ApplyWork = require("../models/ApplyWork");
const WalletTransaction = require("../models/WalletTransaction");
const { changeFunds, isWalletAmount } = require("../services/walletFunds");
const { roleError } = require("../services/adminWorkRoles");

/**
 * PATCH_95: Dataset + RLHF Submission Controller
 * Handles Dataset CRUD, DatasetTask CRUD, RLHF submission, review, and worker metrics
 */

// ═══════════════════════════════════════════════
// ADMIN: DATASET CRUD
// ═══════════════════════════════════════════════

exports.adminGetDatasets = async (req, res) => {
  try {
    const datasets = await Dataset.find()
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    // Attach task counts and submission counts
    const enriched = await Promise.all(
      datasets.map(async (ds) => {
        const taskCount = await DatasetTask.countDocuments({
          datasetId: ds._id,
        });
        const submissionCount = await RlhfSubmission.countDocuments({
          datasetId: ds._id,
        });
        return { ...ds, taskCount, submissionCount };
      }),
    );

    res.json({ success: true, datasets: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminCreateDataset = async (req, res) => {
  try {
    const {
      name,
      description,
      datasetType,
      difficultyLevel,
      minJustificationWords,
      minWordCount,
      allowMultiResponseComparison,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "Dataset name is required" });
    }

    const dataset = await Dataset.create({
      name: name.trim(),
      description: description || "",
      datasetType: datasetType || "ranking",
      difficultyLevel: difficultyLevel || "intermediate",
      minJustificationWords: minJustificationWords ?? 30,
      minWordCount: minWordCount ?? 0,
      allowMultiResponseComparison: allowMultiResponseComparison ?? false,
      isActive: false,
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, dataset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminGetDataset = async (req, res) => {
  try {
    const dataset = await Dataset.findById(req.params.id)
      .populate("createdBy", "name email")
      .lean();
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    const tasks = await DatasetTask.find({ datasetId: dataset._id })
      .sort({ createdAt: -1 })
      .lean();
    const submissionCount = await RlhfSubmission.countDocuments({
      datasetId: dataset._id,
    });

    res.json({ success: true, dataset, tasks, submissionCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateDataset = async (req, res) => {
  try {
    const {
      name,
      description,
      datasetType,
      difficultyLevel,
      minJustificationWords,
      minWordCount,
      allowMultiResponseComparison,
      isActive,
    } = req.body;

    const dataset = await Dataset.findById(req.params.id);
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    if (name !== undefined) dataset.name = name.trim();
    if (description !== undefined) dataset.description = description;
    if (datasetType !== undefined) dataset.datasetType = datasetType;
    if (difficultyLevel !== undefined)
      dataset.difficultyLevel = difficultyLevel;
    if (minJustificationWords !== undefined)
      dataset.minJustificationWords = minJustificationWords;
    if (minWordCount !== undefined) dataset.minWordCount = minWordCount;
    if (allowMultiResponseComparison !== undefined)
      dataset.allowMultiResponseComparison = allowMultiResponseComparison;
    if (isActive !== undefined) dataset.isActive = isActive;

    await dataset.save();
    res.json({ success: true, dataset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminDeleteDataset = async (req, res) => {
  try {
    const dataset = await Dataset.findById(req.params.id);
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    // Check if any project links to this dataset
    const linkedProjects = await Project.countDocuments({
      datasetId: dataset._id,
    });
    if (linkedProjects > 0) {
      return res
        .status(400)
        .json({
          message: `Cannot delete — ${linkedProjects} project(s) linked to this dataset`,
        });
    }

    await DatasetTask.deleteMany({ datasetId: dataset._id });
    await Dataset.findByIdAndDelete(dataset._id);
    res.json({ success: true, message: "Dataset and tasks deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ═══════════════════════════════════════════════
// ADMIN: DATASET TASK CRUD
// ═══════════════════════════════════════════════

exports.adminAddTask = async (req, res) => {
  try {
    const dataset = await Dataset.findById(req.params.id);
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    const {
      prompt,
      responseA,
      responseB,
      imageUrl,
      metadata,
      batchId,
      correctAnswer,
      referenceSources,
    } = req.body;
    if (!prompt?.trim())
      return res.status(400).json({ message: "Prompt is required" });

    const task = await DatasetTask.create({
      datasetId: dataset._id,
      prompt: prompt.trim(),
      responseA: responseA || "",
      responseB: responseB || "",
      imageUrl: imageUrl || "",
      metadata: metadata || {},
      batchId: batchId || "",
      correctAnswer: correctAnswer || "",
      referenceSources: referenceSources || [],
    });

    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminBulkAddTasks = async (req, res) => {
  try {
    const dataset = await Dataset.findById(req.params.id);
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ message: "Tasks array is required" });
    }

    const docs = tasks.map((t) => ({
      datasetId: dataset._id,
      prompt: (t.prompt || "").trim(),
      responseA: t.responseA || "",
      responseB: t.responseB || "",
      imageUrl: t.imageUrl || "",
      metadata: t.metadata || {},
      batchId: t.batchId || "",
      correctAnswer: t.correctAnswer || "",
      referenceSources: t.referenceSources || [],
    }));

    const created = await DatasetTask.insertMany(docs);
    res
      .status(201)
      .json({ success: true, count: created.length, tasks: created });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateTask = async (req, res) => {
  try {
    const task = await DatasetTask.findOne({ _id: req.params.taskId, datasetId: req.params.id });
    if (!task) return res.status(404).json({ message: "Task not found" });

    const {
      prompt,
      responseA,
      responseB,
      imageUrl,
      metadata,
      batchId,
      correctAnswer,
      referenceSources,
      isActive,
    } = req.body;
    if (prompt !== undefined) task.prompt = prompt.trim();
    if (responseA !== undefined) task.responseA = responseA;
    if (responseB !== undefined) task.responseB = responseB;
    if (imageUrl !== undefined) task.imageUrl = imageUrl;
    if (metadata !== undefined) task.metadata = metadata;
    if (batchId !== undefined) task.batchId = batchId;
    if (correctAnswer !== undefined) task.correctAnswer = correctAnswer;
    if (referenceSources !== undefined)
      task.referenceSources = referenceSources;
    if (isActive !== undefined) task.isActive = isActive;

    await task.save();
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminDeleteTask = async (req, res) => {
  try {
    await DatasetTask.db.transaction(async session => {
      const task = await DatasetTask.findOneAndDelete({ _id: req.params.taskId, datasetId: req.params.id }, { session });
      if (!task) throw roleError(404, "Task not found");
      if (await RlhfSubmission.exists({ taskId: task._id }).session(session)) {
        throw roleError(409, "Deactivate this task to preserve its submission and payment history");
      }
    });
    res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

// ═══════════════════════════════════════════════
// WORKER: RLHF TASK EXECUTION
// ═══════════════════════════════════════════════

exports.workerGetProjectTasks = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.projectType !== "rlhf_dataset") {
      return res.status(400).json({ message: "This is not an RLHF project" });
    }
    // PATCH_96: Ownership check — only assigned worker can access tasks
    if (String(project.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not assigned to this project" });
    }
    if (!["assigned", "in_progress"].includes(project.status)) return res.status(409).json({ message: "This assignment is closed" });

    const dataset = await Dataset.findOne({ _id: project.datasetId, isActive: true }).lean();
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });

    const tasks = await DatasetTask.find({
      datasetId: dataset._id,
      isActive: true,
    })
      .select("prompt responseA responseB imageUrl referenceSources")
      .sort({ createdAt: 1 })
      .lean();

    // Get worker's existing submissions
    const submissions = await RlhfSubmission.find({
      projectId: project._id,
      workerId: req.user.id,
    }).lean();

    const submittedTaskIds = new Set(
      submissions.map((s) => s.taskId.toString()),
    );

    const tasksWithStatus = tasks.map((t) => ({
      ...t,
      submitted: submittedTaskIds.has(t._id.toString()),
    }));

    res.json({
      success: true,
      dataset,
      tasks: tasksWithStatus,
      project: {
        _id: project._id,
        title: project.title,
        rewardPerTask: project.rewardPerTask,
      },
      submissionCount: submissions.length,
      totalTasks: tasks.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.workerSubmitTask = async (req, res) => {
  try {
    const { taskId, answerPayload } = req.body;
    if (!Project.base.isObjectIdOrHexString(taskId)) return res.status(400).json({ message: "A valid task ID is required" });
    if (!answerPayload || typeof answerPayload !== "object" || Array.isArray(answerPayload)) {
      return res.status(400).json({ message: "answerPayload is required" });
    }

    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (project.projectType !== "rlhf_dataset") {
      return res.status(400).json({ message: "Not an RLHF project" });
    }
    // PATCH_96: Ownership check — only assigned worker can submit
    if (String(project.assignedTo) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not assigned to this project" });
    }
    if (!["assigned", "in_progress"].includes(project.status)) return res.status(409).json({ message: "This assignment is closed" });

    const task = await DatasetTask.findOne({ _id: taskId, datasetId: project.datasetId, isActive: true }).lean();
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Check for duplicate
    const existing = await RlhfSubmission.findOne({
      taskId: task._id,
      workerId: req.user.id,
    });
    if (existing) {
      return res.status(400).json({ message: "Already submitted this task" });
    }

    // Auto-score based on dataset type
    const dataset = await Dataset.findOne({ _id: project.datasetId, isActive: true }).lean();
    if (!dataset) return res.status(404).json({ message: "Dataset not found" });
    let autoScore = 50; // default partial credit

    if (dataset) {
      const dt = dataset.datasetType;
      if (dt === "ranking") {
        const hasChoice =
          answerPayload.choice === "A" || answerPayload.choice === "B";
        const justWords = (answerPayload.justification || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        autoScore =
          hasChoice && justWords >= (dataset.minJustificationWords || 30)
            ? 80
            : 30;
      } else if (dt === "generation" || dt === "red_team") {
        const words = (answerPayload.response || answerPayload.prompt || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        autoScore = words >= (dataset.minWordCount || 20) ? 70 : 30;
      } else if (dt === "fact_check") {
        const hasVerdict = [
          "true",
          "false",
          "misleading",
          "unverifiable",
        ].includes(answerPayload.verdict);
        autoScore = hasVerdict && answerPayload.explanation ? 70 : 30;
      } else if (dt === "coding") {
        autoScore = (answerPayload.code || "").length >= 10 ? 70 : 30;
      } else if (dt === "multimodal") {
        autoScore = answerPayload.description && answerPayload.rating ? 70 : 30;
      }
    }

    const submission = await RlhfSubmission.db.transaction(async session => {
      // Serialize acceptance with project cancellation, dataset retirement or task removal.
      // The version increment is internal and leaves the editor's displayed timestamp intact.
      for (const [model, filter] of [
        [Project, { _id: project._id, projectType: "rlhf_dataset", assignedTo: req.user.id, datasetId: dataset._id, status: { $in: ["assigned", "in_progress"] } }],
        [Dataset, { _id: dataset._id, isActive: true, updatedAt: dataset.updatedAt || null }],
        [DatasetTask, { _id: task._id, datasetId: dataset._id, isActive: true, updatedAt: task.updatedAt || null }],
      ]) {
        const lock = await model.updateOne(filter, { $inc: { __v: 1 } }, { timestamps: false, session });
        if (!lock.matchedCount) throw roleError(409, "The assigned task changed. Reload it before submitting.");
      }
      const [created] = await RlhfSubmission.create([{
        projectId: project._id, datasetId: project.datasetId, taskId: task._id, workerId: req.user.id,
        answerPayload, autoScore, reviewStatus: "pending_review",
      }], { session, ordered: true });
      return created;
    });

    res.status(201).json({ success: true, submission });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Already submitted this task" });
    }
    res.status(err.status || 500).json({ message: err.status ? err.message : "Could not submit the dataset task." });
  }
};

// ═══════════════════════════════════════════════
// ADMIN: RLHF SUBMISSION REVIEW
// ═══════════════════════════════════════════════

exports.adminGetSubmissions = async (req, res) => {
  try {
    const { projectId, workerId, datasetId, reviewStatus } = req.query;
    const filter = {};
    if (projectId) filter.projectId = projectId;
    if (workerId) filter.workerId = workerId;
    if (datasetId) filter.datasetId = datasetId;
    if (reviewStatus) filter.reviewStatus = reviewStatus;

    const submissions = await RlhfSubmission.find(filter)
      .populate("projectId", "title rewardPerTask")
      .populate("datasetId", "name datasetType")
      .populate("taskId", "prompt responseA responseB imageUrl")
      .populate("workerId", "name email")
      .populate("reviewedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json({ success: true, submissions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminReviewSubmission = async (req, res) => {
  try {
    const { action, finalScore, rewardOverride } = req.body;
    if (!["approved", "rejected"].includes(action)) {
      return res
        .status(400)
        .json({ message: "Action must be 'approved' or 'rejected'" });
    }

    if (!Project.base.isObjectIdOrHexString(req.params.submissionId)) throw roleError(400, "Invalid submission ID");
    if (finalScore !== undefined && (!Number.isFinite(finalScore) || finalScore < 0 || finalScore > 100)) {
      throw roleError(400, "The final score must be between 0 and 100");
    }
    const submission = await RlhfSubmission.db.transaction(async session => {
      const row = await RlhfSubmission.findById(req.params.submissionId).session(session);
      if (!row) throw roleError(404, "Submission not found");
      if (row.reviewStatus !== "pending_review" || row.rewardCredited) throw roleError(409, "This submission has already been reviewed or credited");
      if (action === "approved") {
        const project = await Project.findOne({ _id: row.projectId, datasetId: row.datasetId, assignedTo: row.workerId,
          projectType: "rlhf_dataset", status: { $in: ["assigned", "in_progress", "completed"] } }).session(session).lean();
        if (!project) throw roleError(409, "This submission no longer matches its worker assignment. Review the project.");
        const task = await DatasetTask.exists({ _id: row.taskId, datasetId: row.datasetId }).session(session);
        if (!task) throw roleError(409, "This submission no longer matches its dataset task.");
        const amount = rewardOverride ?? project.rewardPerTask ?? 0;
        if (amount !== 0 && !isWalletAmount(amount)) throw roleError(400, "Use a nonnegative USD reward with at most two decimal places");
        if (amount > 0) {
          const funds = await changeFunds(row.workerId, amount, "earning", session);
          const filter = { user: row.workerId, ...(project.workPositionId ? { position: project.workPositionId } : { currentProject: row.projectId }) };
          await ApplyWork.updateOne(filter, { $inc: { totalEarnings: amount } }, { session });
          await WalletTransaction.create([{ user: row.workerId, type: "credit", source: "earning", provider: "internal", status: "success",
            referenceId: row._id, amount, balanceBefore: funds.balanceBefore, balanceAfter: funds.walletBalance,
            description: "Dataset task reward: " + project.title }], { session, ordered: true });
          row.set({ rewardAmount: amount, rewardCredited: true });
        }
      }
      row.set({ reviewStatus: action, reviewedBy: req.user.id, reviewedAt: new Date() });
      if (finalScore !== undefined) row.finalScore = finalScore;
      await row.save({ session });
      return row;
    });
    await updateWorkerRlhfMetrics(submission.workerId);
    res.json({ success: true, submission });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.status ? err.message : "Could not review the submission." });
  }
};

// ═══════════════════════════════════════════════
// WORKER RLHF METRICS UPDATE
// ═══════════════════════════════════════════════

async function updateWorkerRlhfMetrics(workerId) {
  try {
    const allSubs = await RlhfSubmission.find({ workerId }).lean();
    const total = allSubs.length;
    const reviewed = allSubs.filter((s) => s.reviewStatus !== "pending_review");
    const approved = reviewed.filter((s) => s.reviewStatus === "approved");
    const approvalRate =
      reviewed.length > 0
        ? Math.round((approved.length / reviewed.length) * 100)
        : 0;

    const totalScore = approved.reduce(
      (sum, s) => sum + (s.finalScore ?? s.autoScore ?? 0),
      0,
    );
    const avgScore =
      approved.length > 0 ? Math.round(totalScore / approved.length) : 0;

    // Justification quality: average auto-score as proxy
    const justQuality =
      allSubs.length > 0
        ? Math.round(
            allSubs.reduce((sum, s) => sum + (s.autoScore || 0), 0) /
              allSubs.length,
          )
        : 0;

    await ApplyWork.updateMany(
      { user: workerId },
      {
        rlhfScore: avgScore,
        totalAnnotations: total,
        approvalRate,
        justificationQualityScore: justQuality,
      },
    );
  } catch (err) {
    console.error("updateWorkerRlhfMetrics error:", err.message);
  }
}

module.exports = {
  adminGetDatasets: exports.adminGetDatasets,
  adminCreateDataset: exports.adminCreateDataset,
  adminGetDataset: exports.adminGetDataset,
  adminUpdateDataset: exports.adminUpdateDataset,
  adminDeleteDataset: exports.adminDeleteDataset,
  adminAddTask: exports.adminAddTask,
  adminBulkAddTasks: exports.adminBulkAddTasks,
  adminUpdateTask: exports.adminUpdateTask,
  adminDeleteTask: exports.adminDeleteTask,
  workerGetProjectTasks: exports.workerGetProjectTasks,
  workerSubmitTask: exports.workerSubmitTask,
  adminGetSubmissions: exports.adminGetSubmissions,
  adminReviewSubmission: exports.adminReviewSubmission,
};
