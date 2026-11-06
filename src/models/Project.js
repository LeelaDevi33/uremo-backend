const mongoose = require("mongoose");

/**
 * PATCH_38: Project model for worker assignments
 * PATCH_86: Added workPositionId - Projects MUST belong to a Job Role
 * Admin creates projects, assigns to ready workers, tracks completion and earnings
 */
const projectSchema = new mongoose.Schema(
  {
    paidOfferRevision: { type: Number, default: 0, select: false },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // PATCH_86: Projects MUST belong to a Job Role
    // This determines which workers are eligible (those who passed the job role's screening)
    workPositionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkPosition",
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 48,
    },
    // Project details
    instructions: {
      type: String,
      default: "",
    },
    deliverables: [
      {
        title: String,
        description: String,
        required: { type: Boolean, default: true },
      },
    ],
    // Payment
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    payRate: {
      type: Number,
      required: true,
    },
    payType: {
      type: String,
      enum: ["per_task", "hourly", "fixed"],
      default: "per_task",
    },
    estimatedTasks: {
      type: Number,
      default: 1,
    },
    // Assignment
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    assignedAt: Date,
    // PATCH_65.1: Link project to required screening test
    screeningId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Screening",
    },
    // PATCH_88: Multiple screening tests per project
    screeningIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Screening",
      },
    ],
    // Status tracking
    status: {
      type: String,
      enum: [
        "draft",
        "open",
        "assigned",
        "in_progress",
        "completed",
        "cancelled",
      ],
      default: "draft",
    },
    // Completion
    completedAt: Date,
    completionNotes: String,
    adminRating: {
      type: Number,
      min: 1,
      max: 5,
    },
    // Earnings credited
    earningsCredited: {
      type: Number,
      default: 0,
    },
    creditedAt: Date,
    // Deadline
    deadline: Date,
    // Created by admin
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // PATCH_95: RLHF Dataset Engine
    projectType: {
      type: String,
      enum: ["standard", "rlhf_dataset"],
      default: "standard",
    },
    datasetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Dataset",
      default: null,
    },
    rewardPerTask: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Project", projectSchema);
