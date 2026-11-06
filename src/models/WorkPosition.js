const mongoose = require("mongoose");

/**
 * PATCH_43: Enhanced WorkPosition (Job Role) model
 * Links to services, has screening setup, training materials
 */

const simpleText = {
  type: String,
  trim: true,
  default: "",
};

const workPositionSchema = new mongoose.Schema(
  {
    applicationRevision: { type: Number, default: 0, select: false },
    title: {
      ...simpleText,
      required: true,
    },
    category: {
      ...simpleText,
      required: true,
      index: true,
    },
    description: {
      ...simpleText,
      default: "",
    },
    requirements: {
      ...simpleText,
      default: "",
    },
    // PATCH_43: Link to originating service (for auto-created job roles)
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      index: true,
    },
    // PATCH_43: Screening setup
    hasScreening: {
      type: Boolean,
      default: false,
    },
    screeningId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Screening",
    },
    // PATCH_89: Multiple screenings per job role
    screeningIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Screening",
      },
    ],
    // PATCH_43: Training materials attached to job role
    trainingMaterials: [
      {
        title: { type: String, trim: true },
        type: { type: String, enum: ["link", "pdf", "video"], default: "link" },
        url: { type: String, trim: true },
        description: { type: String, trim: true, default: "" },
      },
    ],
    // PATCH_43: Admin notes for job role
    adminNotes: {
      type: String,
      default: "",
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  { timestamps: true },
);

workPositionSchema.index({ active: 1, sortOrder: 1, createdAt: -1 });
workPositionSchema.index({ serviceId: 1 });

module.exports = mongoose.model("WorkPosition", workPositionSchema);
