/**
 * PATCH_110: Wallet Withdrawal Request Model
 *
 * Tracks withdrawal requests from wallet balance.
 * All operations are atomic and reference WalletTransaction for audit trail.
 *
 * Flow:
 *   1. User requests → status=pending, withdrawable decremented, pendingWithdrawals incremented
 *   2. Admin approves → status=approved (no balance change yet)
 *   3. Admin marks paid → status=paid, balance decremented, pendingWithdrawals decremented
 *   4. Admin rejects  → status=rejected, withdrawable restored, pendingWithdrawals decremented
 */
const mongoose = require("mongoose");

const withdrawalRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 10, // Minimum withdrawal $10
    },
    requestId: { type: String, maxlength: 100 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid"],
      default: "pending",
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    adminNote: {
      type: String,
      default: "",
    },
    // Reference to the WalletTransaction created for this withdrawal
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null,
    },
    // Reference to the completion transaction when marked as paid
    completionTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WalletTransaction",
      default: null,
    },
  },
  { timestamps: true },
);

// Index for admin queries
withdrawalRequestSchema.index({ status: 1, createdAt: -1 });
withdrawalRequestSchema.index({ userId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } });

module.exports = mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
