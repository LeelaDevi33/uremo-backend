/**
 * PATCH-64: Admin Audit Logger
 *
 * Logs ALL critical admin actions for accountability and debugging.
 * Every guarded action must be logged with:
 * - adminId
 * - entityId
 * - action type
 * - previous state → new state
 * - timestamp
 */

const AdminAuditLog = require("../models/AdminAuditLog");
const User = require("../models/User");

/**
 * Log an admin action
 * @param {Object} params
 * @param {string} params.adminId - Admin user ID
 * @param {string} params.adminEmail - Admin email (for quick reference)
 * @param {string} params.action - Action type (e.g., "payment_verify", "worker_approve")
 * @param {string} params.entityType - Entity type (e.g., "order", "worker", "wallet")
 * @param {string} params.entityId - Entity ID
 * @param {Object} params.previousState - State before action
 * @param {Object} params.newState - State after action
 * @param {string} params.reason - Optional reason provided by admin
 * @param {Object} params.metadata - Any additional data
 */
async function logAdminAction({
  adminId,
  adminEmail,
  action,
  entityType,
  entityId,
  previousState,
  newState,
  reason,
  metadata,
}, { session, required = false } = {}) {
  try {
    const actorEmail = adminEmail || (await User.findById(adminId).select("email").session(session || null).lean())?.email;
    await new AdminAuditLog({
      adminId,
      adminEmail: actorEmail,
      action,
      entityType,
      entityId,
      previousState,
      newState,
      reason,
      metadata,
      timestamp: new Date(),
    }).save({ session });
  } catch (err) {
    if (required) throw err;
    // Log to console but don't fail the action
    console.error("[AdminAudit] Failed to log action:", {
      action,
      entityType,
      entityId,
      error: err.message,
    });
  }
}

/**
 * Get audit logs for an entity
 * @param {string} entityType
 * @param {string} entityId
 * @param {number} limit
 */
async function getEntityAuditLogs(entityType, entityId, limit = 50) {
  try {
    return await AdminAuditLog.find({ entityType, entityId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  } catch (err) {
    console.error("[AdminAudit] Failed to get logs:", err.message);
    return [];
  }
}

/**
 * Get recent admin actions
 * @param {string} adminId
 * @param {number} limit
 */
async function getAdminActions(adminId, limit = 100) {
  try {
    return await AdminAuditLog.find({ adminId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  } catch (err) {
    console.error("[AdminAudit] Failed to get admin actions:", err.message);
    return [];
  }
}

module.exports = {
  logAdminAction,
  getEntityAuditLogs,
  getAdminActions,
};
