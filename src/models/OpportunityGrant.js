const mongoose = require("mongoose");
const { Schema } = mongoose;

const schema = new Schema({
  opportunityId: { type: Schema.Types.ObjectId, ref: "Opportunity", required: true },
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
}, { timestamps: true });

schema.index({ userId: 1, requestId: 1 }, { unique: true });
schema.index({ userId: 1, opportunityId: 1, startsAt: -1 });
schema.index({ opportunityId: 1, type: 1 }, { unique: true, partialFilterExpression: { type: "buy" } });
module.exports = mongoose.model("OpportunityGrant", schema);
