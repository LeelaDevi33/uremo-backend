const mongoose = require("mongoose");
const { Schema } = mongoose;

const schema = new Schema({
  title: { type: String, trim: true, maxlength: 160, default: "" },
  description: { type: String, trim: true, maxlength: 4000, default: "" },
  category: { type: String, enum: ["", "development", "design", "operations", "writing", "data", "research", "other"], default: "" },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
  rightsConfirmed: { type: Boolean, default: false },
  deliverable: { type: String, trim: true, maxlength: 8000, default: "", select: false },
  applyEnabled: { type: Boolean, default: false },
  workPositionId: { type: Schema.Types.ObjectId, ref: "WorkPosition", default: null },
  // The historical unique role index can remain in place during a rolling
  // migration. New offers link to a specific project, sharing its specialization.
  projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
  projectRoleId: { type: Schema.Types.ObjectId, ref: "WorkPosition", default: null },
  rentEnabled: { type: Boolean, default: false },
  rentPrice: { type: Number, min: 0, default: 0 },
  rentalDays: { type: Number, min: 0, max: 365, default: 0 },
  buyEnabled: { type: Boolean, default: false },
  buyPrice: { type: Number, min: 0, default: 0 },
  currency: { type: String, enum: ["USD"], default: "USD" },
  firstPublishedAt: Date,
  projectPublishedAt: Date,
  preserveRoleUntilPublished: { type: Boolean, default: false, select: false },
  soldAt: { type: Date, default: null },
  closedForRefundReviewAt: Date,
  rentedUntil: { type: Date, default: null },
  applicationCount: { type: Number, default: 0 },
}, { timestamps: true });

schema.index({ workPositionId: 1 }, { unique: true, partialFilterExpression: { workPositionId: { $type: "objectId" } } });
schema.index({ projectId: 1 }, { unique: true, partialFilterExpression: { projectId: { $type: "objectId" } } });
schema.index({ status: 1, soldAt: 1, createdAt: -1 });
module.exports = mongoose.model("Opportunity", schema);
