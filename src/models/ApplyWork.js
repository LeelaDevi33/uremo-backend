const mongoose = require("mongoose");

/**
 * PATCH_38/43: Enhanced ApplyWork schema with worker status flow
 * PATCH_43: Full worker journey states
 * Applied → Screening Unlocked → Test Submitted → Ready To Work → Assigned → Working
 */
const applyWorkSchema = new mongoose.Schema(
  {
    paidOfferRevision: { type: Number, default: 0, select: false },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    position: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkPosition",
    },
    positionTitle: {
      type: String,
      default: "",
      trim: true,
    },
    category: {
      type: String,
      default: "",
    },
    resumeUrl: {
      type: String,
      default: "",
      trim: true,
    },
    resumePublicId: {
      type: String,
    },
    resumeResourceType: {
      type: String,
      enum: ["image", "raw"],
    },
    resumeFormat: {
      type: String,
    },
    resumeOriginalName: {
      type: String,
    },
    resumeMimeType: {
      type: String,
    },
    message: {
      type: String,
    },
    // PATCH_43: Application status (admin review)
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    // PATCH_43: Worker journey states (authoritative)
    workerStatus: {
      type: String,
      enum: [
        "applied", // Just applied, waiting for admin approval
        "screening_unlocked", // Admin approved + unlocked screening
        "training_viewed", // PATCH_49: Viewed training materials, ready for test
        "test_submitted", // Submitted test, awaiting grading
        "failed", // Failed test (used all attempts)
        "ready_to_work", // Passed screening, available for projects
        "assigned", // Has active project assignment
        "working", // Currently working on project
        "suspended", // Admin suspended worker
        // Legacy states for backwards compat
        "fresh",
        "screening_available",
        "inactive",
      ],
      default: "applied",
    },
    // PATCH_49: Timestamp when training was viewed
    trainingViewedAt: {
      type: Date,
    },
    // PATCH_43: Attempt tracking for retries
    attemptCount: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 2,
    },
    // Screening/Test tracking
    // PATCH_90: Expanded with hybrid rubric fields
    screeningsCompleted: [
      {
        screeningId: { type: mongoose.Schema.Types.ObjectId, ref: "Screening" },
        completedAt: Date,
        score: Number,
        passed: Boolean,
        // PATCH_90: Hybrid rubric engine fields
        autoScore: { type: Number, default: null },
        autoPass: { type: Boolean, default: null },
        submissionStatus: {
          type: String,
          enum: ["auto_graded", "pending_review", "approved", "rejected"],
          default: "auto_graded",
        },
        rubricBreakdown: [
          {
            criteria: String,
            weight: Number,
            maxScore: Number,
            awarded: { type: Number, default: 0 },
          },
        ],
        validationFlags: [
          {
            rule: String,
            passed: Boolean,
            detail: String,
          },
        ],
        adminReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        adminReviewedAt: Date,
        adminScore: { type: Number, default: null },
        answers: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    testsCompleted: [
      {
        testId: { type: mongoose.Schema.Types.ObjectId, ref: "Test" },
        completedAt: Date,
        score: Number,
        passed: Boolean,
      },
    ],
    // Active project assignment
    currentProject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
    },
    projectsCompleted: [
      {
        projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
        completedAt: Date,
        rating: Number,
        earnings: Number,
      },
    ],
    // Earnings tracking
    totalEarnings: {
      type: Number,
      default: 0,
    },
    pendingEarnings: {
      type: Number,
      default: 0,
    },
    payRate: {
      type: Number,
      default: 0,
    },
    // PATCH_61B: Specialized tasks assigned by admin
    assignedTasks: [
      {
        _id: mongoose.Schema.Types.ObjectId,
        description: String,
        assignedAt: { type: Date, default: Date.now },
        status: {
          type: String,
          enum: ["pending", "in-progress", "completed"],
          default: "pending",
        },
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        completedAt: Date,
        notes: String,
      },
    ],
    // Admin notes
    adminNotes: {
      type: String,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedAt: Date,
    // PATCH_90: Worker tier system
    qualityScore: {
      type: Number,
      default: 0,
    },
    tier: {
      type: String,
      enum: ["bronze", "silver", "gold", "elite"],
      default: "bronze",
    },
    // PATCH_95: RLHF Worker Quality Metrics
    rlhfScore: { type: Number, default: 0 },
    totalAnnotations: { type: Number, default: 0 },
    approvalRate: { type: Number, default: 0 },
    justificationQualityScore: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ApplyWork", applyWorkSchema);
