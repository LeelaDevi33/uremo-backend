/**
 * PATCH_31: Platform Flow Orchestration Engine
 *
 * Central orchestration layer for all lifecycle state changes.
 * All status mutations (orders, tickets, rentals, wallet, affiliate)
 * must pass through this engine.
 *
 * Responsibilities:
 * - Validate allowed state transitions
 * - Update entity status
 * - Append timeline log
 * - Emit events for hooks
 * - Trigger downstream actions (notifications, affiliate processing)
 */

const EventEmitter = require("events");
const emitter = new EventEmitter();

// Increase max listeners to avoid warnings with many hooks
emitter.setMaxListeners(50);

// Models (lazy-loaded to avoid circular dependencies)
let Order, Ticket, Rental, WalletTransaction;

const loadModels = () => {
  if (!Order) Order = require("../models/Order");
  if (!Ticket) Ticket = require("../models/Ticket");
  if (!Rental) Rental = require("../models/Rental");
  if (!WalletTransaction)
    WalletTransaction = require("../models/WalletTransaction");
};

/**
 * STATE TRANSITION MAPS
 *
 * Defines all valid state transitions for each entity type.
 * Format: { [currentState]: [allowedNextStates] }
 *
 * NOTE: States are adapted to match existing model enums.
 */
const STATE_MAP = {
  // PATCH_37: Order states normalized
  order: {
    pending: ["in_progress", "cancelled"],
    in_progress: ["waiting_user", "completed", "cancelled"],
    waiting_user: ["in_progress", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },

  // Ticket states matching Ticket.js enum
  ticket: {
    open: ["in_progress", "waiting_user", "closed"],
    in_progress: ["waiting_user", "closed"],
    waiting_user: ["in_progress", "closed"],
    closed: [], // Terminal state
  },

  // Rental states matching Rental.js enum
  rental: {
    pending: ["active", "cancelled"],
    active: ["expired", "cancelled", "renewed"],
    expired: ["renewed"], // Can renew expired rental
    cancelled: [],
    renewed: ["active", "expired"],
  },

  // Wallet transaction states
  wallet: {
    pending: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  },

  // Affiliate withdrawal states
  affiliate_withdrawal: {
    pending: ["approved", "rejected"],
    approved: ["paid"],
    paid: [],
    rejected: [],
  },
};

/**
 * Get the model for a given entity type
 */
const getModel = (type) => {
  loadModels();

  const models = {
    order: Order,
    ticket: Ticket,
    rental: Rental,
    wallet: WalletTransaction,
  };

  return models[type];
};

/**
 * Validate a state transition
 *
 * @param {string} type - Entity type (order, ticket, rental, wallet)
 * @param {string} currentState - Current status
 * @param {string} nextState - Desired next status
 * @returns {boolean} - Whether the transition is valid
 */
const isValidTransition = (type, currentState, nextState) => {
  const stateMap = STATE_MAP[type];
  if (!stateMap) return false;

  const allowedStates = stateMap[currentState];
  if (!allowedStates) return false;

  return allowedStates.includes(nextState);
};

/**
 * Get allowed next states for an entity
 *
 * @param {string} type - Entity type
 * @param {string} currentState - Current status
 * @returns {string[]} - List of allowed next states
 */
const getAllowedTransitions = (type, currentState) => {
  const stateMap = STATE_MAP[type];
  if (!stateMap) return [];

  return stateMap[currentState] || [];
};

/**
 * Main transition function
 *
 * Transitions an entity from its current state to a new state,
 * handling validation, timeline logging, and event emission.
 *
 * @param {string} type - Entity type (order, ticket, rental, wallet)
 * @param {string|ObjectId} id - Entity ID
 * @param {string} nextState - Desired next status
 * @param {Object} meta - Additional metadata for the transition
 * @param {string} [meta.actor] - Who initiated the transition (system, admin, user)
 * @param {string} [meta.reason] - Reason for the transition
 * @param {string} [meta.adminId] - Admin user ID if admin-initiated
 * @param {Object} [meta.data] - Additional data to store
 * @returns {Promise<Object>} - Updated entity
 */
async function transition(type, id, nextState, meta = {}) {
  loadModels();

  const Model = getModel(type);
  if (!Model) {
    throw new Error(`Unknown entity type: ${type}`);
  }

  // Fetch the entity
  const item = await Model.findById(id);
  if (!item) {
    throw new Error(`${type} not found: ${id}`);
  }

  const event = await saveTransition(type, item, nextState, meta);
  publishTransition(type, event);
  return item;
}

// A document loaded in a MongoDB transaction keeps its session on save().
// Callers performing a settlement publish the event after the transaction commits.
async function saveTransition(type, item, nextState, meta) {
  const currentState = item.status;

  // Validate the transition
  if (!isValidTransition(type, currentState, nextState)) {
    const allowed = getAllowedTransitions(type, currentState);
    throw new Error(
      `Invalid transition: ${type} cannot go from "${currentState}" to "${nextState}". ` +
        `Allowed transitions: [${allowed.join(", ")}]`,
    );
  }

  // Update status
  const previousState = item.status;
  item.status = nextState;

  // Build timeline entry
  const timelineEntry = {
    event: nextState,
    from: previousState,
    at: new Date(),
    actor: meta.actor || "system",
    reason: meta.reason || null,
    meta: meta.data || {},
  };

  // Append to timeline (ensure array exists)
  // Different models may have different timeline field structures
  if (type === "order") {
    // Order has both statusLog and timeline
    item.statusLog = item.statusLog || [];
    item.statusLog.push({
      text: meta.reason || `Status changed to ${nextState}`,
      at: new Date(),
    });

    item.timeline = item.timeline || [];
    item.timeline.push({
      message: meta.reason || `Status: ${previousState} → ${nextState}`,
      by: meta.actor || "system",
      createdAt: new Date(),
    });

    // Handle special order transitions (PATCH_37: normalized statuses)
    const confirmingPayment = previousState === "pending" || meta.paymentMethod === "manual";
    if (nextState === "in_progress" && confirmingPayment) {
      item.payment = item.payment || {};
      item.payment.verifiedAt = new Date();
      item.paidAt = item.paidAt || new Date();
      if (meta.paymentMethod) {
        item.paymentMethod = meta.paymentMethod;
        item.paymentStatus = "paid";
        if (meta.paymentMethod === "manual" && item.quotedAmount != null) {
          item.settledAmount = item.quotedAmount;
          item.settledCurrency = item.quotedCurrency;
        }
      }
    }

    if (nextState === "completed") {
      item.completedAt = new Date();
    }
  } else if (type === "ticket") {
    // Ticket tracks state changes via status field + timestamps
    if (nextState === "closed") {
      item.resolvedAt = new Date();
    }
    if (nextState === "in_progress" && !item.firstResponseAt) {
      item.firstResponseAt = new Date();
    }
  } else if (type === "rental") {
    // Rental has activatedAt, expiredAt, etc.
    if (nextState === "active" && !item.activatedAt) {
      item.activatedAt = new Date();
    }
    if (nextState === "expired") {
      item.expiredAt = new Date();
    }
    if (nextState === "cancelled") {
      item.cancelledAt = new Date();
    }
  }

  // Save the entity
  await item.save();

  return {
    item,
    previousState,
    nextState,
    meta,
    transitionedAt: new Date(),
  };
}

function publishTransition(type, eventPayload) {
  const { item, previousState, nextState, meta, transitionedAt } = eventPayload;
  emitter.emit(`${type}.${nextState}`, eventPayload);

  // Also emit a generic transition event for logging/analytics
  emitter.emit("transition", {
    type,
    id: item._id,
    from: previousState,
    to: nextState,
    meta,
    transitionedAt,
  });

  console.log(
    `[FlowEngine] ${type} ${item._id}: ${previousState} → ${nextState}`,
    meta.reason ? `(${meta.reason})` : "",
  );
}

/**
 * Batch transition - transition multiple entities of the same type
 *
 * @param {string} type - Entity type
 * @param {string[]} ids - Array of entity IDs
 * @param {string} nextState - Desired next status
 * @param {Object} meta - Metadata for all transitions
 * @returns {Promise<Object[]>} - Array of results with success/error for each
 */
async function batchTransition(type, ids, nextState, meta = {}) {
  const results = [];

  for (const id of ids) {
    try {
      const item = await transition(type, id, nextState, meta);
      results.push({ id, success: true, item });
    } catch (err) {
      results.push({ id, success: false, error: err.message });
    }
  }

  return results;
}

/**
 * Check if a transition is allowed without performing it
 *
 * @param {string} type - Entity type
 * @param {string|ObjectId} id - Entity ID
 * @param {string} nextState - Desired next status
 * @returns {Promise<Object>} - { allowed: boolean, reason?: string }
 */
async function canTransition(type, id, nextState) {
  loadModels();

  const Model = getModel(type);
  if (!Model) {
    return { allowed: false, reason: `Unknown entity type: ${type}` };
  }

  const item = await Model.findById(id);
  if (!item) {
    return { allowed: false, reason: `${type} not found` };
  }

  const valid = isValidTransition(type, item.status, nextState);
  if (!valid) {
    const allowed = getAllowedTransitions(type, item.status);
    return {
      allowed: false,
      currentState: item.status,
      reason: `Cannot transition from "${item.status}" to "${nextState}". Allowed: [${allowed.join(", ")}]`,
    };
  }

  return { allowed: true, currentState: item.status };
}

/**
 * Get current state of an entity
 *
 * @param {string} type - Entity type
 * @param {string|ObjectId} id - Entity ID
 * @returns {Promise<string|null>} - Current status or null if not found
 */
async function getCurrentState(type, id) {
  loadModels();

  const Model = getModel(type);
  if (!Model) return null;

  const item = await Model.findById(id).select("status").lean();
  return item?.status || null;
}

/**
 * Register an event hook
 *
 * @param {string} event - Event name (e.g., "order.processing", "ticket.closed")
 * @param {Function} handler - Async handler function
 */
function on(event, handler) {
  emitter.on(event, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      console.error(`[FlowEngine] Hook error for ${event}:`, err.message);
    }
  });
}

/**
 * Register a one-time event hook
 */
function once(event, handler) {
  emitter.once(event, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      console.error(`[FlowEngine] Hook error for ${event}:`, err.message);
    }
  });
}

module.exports = {
  // Core functions
  transition,
  saveTransition,
  publishTransition,
  batchTransition,
  canTransition,
  getCurrentState,

  // Validation utilities
  isValidTransition,
  getAllowedTransitions,

  // State maps (for introspection)
  STATE_MAP,

  // Event system
  emitter,
  on,
  once,
};
