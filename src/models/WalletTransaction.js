/**
 * PATCH_23: Wallet Transaction Model
 * PATCH_80: Added status, provider, providerRef for payment gateway foundation
 *
 * Tracks all wallet balance changes (credits and debits)
 *
 * STATE MACHINE (for topups):
 *   initiated → pending → success (ONLY success updates balance)
 *   initiated → pending → failed (NO balance change)
 *   initiated → failed (timeout or user cancel)
 *
 * For internal operations (service_purchase, admin_adjustment, refund):
 *   Created directly as 'success' since they are instant internal operations
 */
const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    source: {
      type: String,
      enum: [
        "topup",
        "service_purchase",
        "rental_purchase",
        "admin_adjustment",
        "refund",
        "earning",
        "withdrawal_request",
        "withdrawal_completed",
        "rental_payment",
      ],
      required: true,
    },
    /**
     * PATCH_80: Transaction Status
     * PATCH_82: Added 'paid_unverified' for PayPal payments awaiting admin approval
     * - initiated: User requested topup, waiting for payment
     * - pending: Payment in progress (gateway processing)
     * - paid_unverified: Payment confirmed by gateway (PayPal) but awaiting admin verification
     * - success: Payment verified and balance updated
     * - failed: Payment failed or expired
     *
     * CRITICAL: Balance is ONLY updated when status transitions to 'success'
     */
    status: {
      type: String,
      enum: ["initiated", "pending", "paid_unverified", "success", "failed"],
      default: "success", // Default for backward compatibility (existing debits)
    },
    /**
     * PATCH_80: Payment Provider
     * PATCH_82: Added 'paypal' for international PayPal payments
     * - manual: Admin verification (Phase 1)
     * - paypal: PayPal integration (PATCH_82)
     * - stripe: Stripe integration (Future)
     * - paystack: Paystack integration (Future)
     * - flutterwave: Flutterwave integration (Future)
     */
    provider: {
      type: String,
      enum: [
        "manual",
        "paypal",
        "stripe",
        "paystack",
        "flutterwave",
        "internal",
      ],
      default: "internal", // Internal for service purchases, admin adjustments
    },
    /**
     * PATCH_80: External Provider Reference
     * Stores payment gateway transaction ID for reconciliation
     */
    providerRef: {
      type: String,
      default: null,
    },
    methodId: { type: mongoose.Schema.Types.ObjectId, ref: "WalletFundingMethod" },
    methodName: String,
    paymentReference: String,
    gatewayMode: { type: String, enum: ["sandbox", "live"] },
    // Admin verification evidence, kept out of user transaction responses.
    settlementReference: { type: String, select: false },
    settlementVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", select: false },
    // Reference to related document (order ID, etc.)
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    // Additional description for admin adjustments or notes
    description: {
      type: String,
      default: "",
    },
    // PATCH_110: Balance snapshot BEFORE this transaction
    balanceBefore: {
      type: Number,
      default: null,
    },
    // Portion of this marketplace charge or refund backed by withdrawable earnings.
    withdrawablePortion: { type: Number, min: 0 },
    // Balance after this transaction (set when status becomes 'success')
    balanceAfter: {
      type: Number,
      default: null, // Null until transaction succeeds
    },
    /**
     * PATCH_80: Failure reason (if status === 'failed')
     */
    failureReason: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

// Index for fetching user transactions in order
walletTransactionSchema.index({ user: 1, createdAt: -1 });

// PATCH_80: Index for finding pending transactions (admin verification)
walletTransactionSchema.index({ status: 1, createdAt: -1 });

// PATCH_80: Index for provider reference lookups (webhook processing)
walletTransactionSchema.index({ provider: 1, providerRef: 1 });
// Legacy PayPal orders have no wallet transaction ID in their purchase unit.
// Their stored provider order ID must identify exactly one top-up, even after a retry.
walletTransactionSchema.index({ providerRef: 1 }, { unique: true,
  partialFilterExpression: { provider: "paypal", source: "topup", providerRef: { $type: "string" } } });
walletTransactionSchema.index({ user: 1, methodId: 1, paymentReference: 1 }, {
  unique: true, partialFilterExpression: { provider: "manual", paymentReference: { $type: "string" }, status: { $in: ["initiated", "pending"] } },
});
walletTransactionSchema.index({ settlementReference: 1 }, {
  unique: true, partialFilterExpression: { settlementReference: { $type: "string" } },
});

/**
 * PATCH_80: Static method to validate state transitions
 * Enforces the transaction state machine
 */
walletTransactionSchema.statics.isValidTransition = function (from, to) {
  const validTransitions = {
    initiated: ["pending", "paid_unverified", "failed"],
    pending: ["paid_unverified", "success", "failed"],
    // PATCH_82: PayPal payments go to paid_unverified, then admin verifies
    paid_unverified: ["success", "failed"],
    // Terminal states - no transitions allowed
    success: [],
    failed: [],
  };

  return validTransitions[from]?.includes(to) || false;
};

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
