/**
 * PATCH-64: Admin Audit Log Model
 * Stores all critical admin actions for accountability
 */

const mongoose = require("mongoose");

const adminAuditLogSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  adminEmail: {
    type: String,
    required: true,
  },
  action: {
    type: String,
    required: true,
    index: true,
    enum: [
      "payment_verify",
      "wallet_credit",
      "wallet_debit",
      "topup_approve",
      "topup_reject",
      "worker_approve",
      "worker_reject",
      "worker_status_change",
      "project_assign",
      "project_unassign",
      "screening_create",
      "screening_update",
      "affiliate_withdrawal_approve",
      "affiliate_withdrawal_reject",
      "order_status_change",
      "order_cancel",
      "other",
    ],
  },
  entityType: {
    type: String,
    required: true,
    index: true,
    enum: [
      "order",
      "worker",
      "wallet",
      "wallet_transaction",
      "project",
      "screening",
      "affiliate_withdrawal",
      "user",
      "other",
    ],
  },
  entityId: {
    type: String,
    required: true,
    index: true,
  },
  previousState: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  newState: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  reason: {
    type: String,
    default: "",
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// Compound indexes for common queries
adminAuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
adminAuditLogSchema.index({ adminId: 1, timestamp: -1 });
adminAuditLogSchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model("AdminAuditLog", adminAuditLogSchema);
