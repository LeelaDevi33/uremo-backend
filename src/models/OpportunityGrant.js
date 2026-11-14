const mongoose = require("mongoose");
const { Schema } = mongoose;

const schema = new Schema({
  opportunityId: { type: Schema.Types.ObjectId, ref: "Opportunity", required: true },
  projectId: { type: Schema.Types.ObjectId, ref: "Project" },
  workPositionId: { type: Schema.Types.ObjectId, ref: "WorkPosition" },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["buy", "rent"], required: true },
  requestId: { type: String, required: true },
  title: { type: String, required: true },
  projectScope: { type: String, default: "" },
  deliverable: { type: String, required: true, select: false },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, enum: ["USD"], default: "USD" },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, default: null },
  rentalDays: { type: Number, default: null },
  balanceAfter: { type: Number, required: true },
  refundedAt: Date,
  refundReason: { type: String, maxlength: 500, select: false },
  refundedBy: { type: Schema.Types.ObjectId, ref: "User", select: false },
  refundTransactionId: { type: Schema.Types.ObjectId, ref: "WalletTransaction" },
}, { timestamps: true });

schema.index({ userId: 1, requestId: 1 }, { unique: true });
schema.index({ userId: 1, opportunityId: 1, startsAt: -1 });
schema.index({ opportunityId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: "buy" } });
schema.index({ projectId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: "buy", projectId: { $type: "objectId" } } });
module.exports = mongoose.model("OpportunityGrant", schema);
