/**
 * PATCH_51: JarvisX Context Builder
 * Fetches relevant data based on intent BEFORE sending to LLM
 * LLM receives only the data it needs, nothing more
 */

const { INTENTS } = require("./intents");
const { executeTool } = require("./tools");
const Service = require("../models/Service");
const PaymentMethod = require("../models/PaymentMethod");
const WorkPosition = require("../models/WorkPosition");
const { getPublicSettingsObject } = require("../controllers/siteSettings.controller");

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAfterKeyword(message, keywords) {
  const msg = String(message || "").trim();
  if (!msg) return "";
  const pattern = new RegExp(`(?:${keywords.join("|")})\\s+(.*)$`, "i");
  const match = msg.match(pattern);
  return match && match[1] ? match[1].trim() : "";
}

function extractServiceSearchTerm(message) {
  const msg = String(message || "").trim();
  if (!msg) return "";
  const direct = extractAfterKeyword(msg, [
    "buy",
    "purchase",
    "order",
    "get",
    "need",
  ]);
  if (direct) return direct;
  return msg;
}

function extractJobSearchTerm(message) {
  const msg = String(message || "").trim();
  if (!msg) return "";
  const direct = extractAfterKeyword(msg, [
    "work on",
    "work for",
    "apply to",
    "apply for",
    "job",
  ]);
  if (direct) return direct;
  return msg;
}

function parseTicketFromMessage(message) {
  const msg = String(message || "").trim();
  if (!msg) return { shouldCreate: false };

  const generic = /(support|help|ticket|contact)/i.test(msg) && msg.length < 20;
  if (generic) return { shouldCreate: false };

  const aboutMatch = msg.match(/(?:about|regarding|for)\s+(.+?)(?:\.|$)/i);
  const subject = aboutMatch ? aboutMatch[1].trim() : msg.slice(0, 80);

  return {
    shouldCreate: true,
    subject: subject || "Support Request",
    message: msg.slice(0, 500),
  };
}

/**
 * Build context object based on intent
 * PATCH_52B: Now includes state engine data
 * @param {string} intent - Detected intent
 * @param {Object} context - { userId, userRole, isAdmin, activeGoal, currentStep, collectedData, sessionId }
 * @param {Object} params - Extracted parameters from message
 * @returns {Promise<Object>} Context data for response generation
 */
async function buildContext(intent, context, params = {}) {
  const baseContext = {
    intent,
    userId: context.userId || null,
    isAuthenticated: !!context.userId,
    isAdmin: !!context.isAdmin,
    // PATCH_52B: Add state engine context
    sessionId: context.sessionId || null,
    activeGoal: context.activeGoal || null,
    currentStep: context.currentStep || null,
    collectedData: context.collectedData || {},
    timestamp: new Date().toISOString(),
  };

  try {
    switch (intent) {
      // =========== SERVICE DISCOVERY ===========
      case INTENTS.EXPLORE_SERVICES:
      case INTENTS.BUY_SERVICE:
      case INTENTS.RENT_SERVICE:
      case INTENTS.DEAL_SERVICE: {
        const services = await Service.find({ active: true })
          .select("_id title price description category deliveryType imageUrl")
          .limit(20)
          .lean();

        const paymentMethods = await PaymentMethod.find({ active: true })
          .select("_id name details")
          .lean();

        return {
          ...baseContext,
          data: {
            services: services.map((s) => ({
              id: s._id,
              title: s.title,
              price: s.price,
              description: s.description?.slice(0, 150) || "",
              category: s.category,
              deliveryType: s.deliveryType,
            })),
            paymentMethods: paymentMethods.map((m) => ({
              id: m._id,
              name: m.name,
            })),
            serviceCount: services.length,
          },
        };
      }

      // =========== APPLY TO WORK ===========
      case INTENTS.APPLY_TO_WORK: {
        const positions = await WorkPosition.find({ active: true })
          .select("_id title category description requirements")
          .sort({ sortOrder: 1, createdAt: -1 })
          .limit(10)
          .lean();

        return {
          ...baseContext,
          data: {
            positions: positions.map((p) => ({
              id: p._id,
              title: p.title,
              category: p.category,
              description: p.description?.slice(0, 150) || "",
            })),
            positionCount: positions.length,
          },
        };
      }

      // =========== ORDERS ===========
      case INTENTS.MY_ORDERS:
      case INTENTS.ORDER_STATUS:
      case INTENTS.ORDER_HELP: {
        const result = await executeTool("getOrders", params, context);
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { orders: [], error: result.error },
        };
      }

      // =========== RENTALS ===========
      case INTENTS.MY_RENTALS:
      case INTENTS.RENTAL_HELP: {
        const result = await executeTool("getRentals", params, context);
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { rentals: [], error: result.error },
        };
      }

      // =========== WALLET ===========
      case INTENTS.WALLET_BALANCE:
      case INTENTS.WALLET_TOPUP:
      case INTENTS.WALLET_HISTORY: {
        const result = await executeTool("getWallet", params, context);
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { wallet: null, error: result.error },
        };
      }

      // =========== WORKSPACE ===========
      case INTENTS.WORKSPACE_STATUS:
      case INTENTS.SCREENING_HELP:
      case INTENTS.PROJECT_HELP:
      case INTENTS.EARNINGS_STATUS: {
        const result = await executeTool(
          "getWorkspaceProfile",
          params,
          context,
        );
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { profile: null, error: result.error },
        };
      }

      // =========== AFFILIATE ===========
      case INTENTS.AFFILIATE_STATUS:
      case INTENTS.AFFILIATE_LINK: {
        const result = await executeTool("getAffiliateStatus", params, context);
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { affiliate: null, error: result.error },
        };
      }

      // =========== ADMIN ===========
      case INTENTS.ADMIN_DASHBOARD: {
        const result = await executeTool("getAdminStats", params, context);
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { stats: null, error: result.error },
        };
      }

      case INTENTS.ADMIN_PENDING_ORDERS: {
        const result = await executeTool(
          "getAdminPendingOrders",
          params,
          context,
        );
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { orders: [], error: result.error },
        };
      }

      case INTENTS.ADMIN_PENDING_PROOFS: {
        const result = await executeTool(
          "getAdminPendingProofs",
          params,
          context,
        );
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { proofs: [], error: result.error },
        };
      }

      case INTENTS.ADMIN_PENDING_TICKETS: {
        const result = await executeTool(
          "getAdminPendingTickets",
          params,
          context,
        );
        return {
          ...baseContext,
          data: result.success
            ? result.data
            : { tickets: [], error: result.error },
        };
      }

      // =========== ADMIN CREATE SERVICE ===========
      case INTENTS.ADMIN_CREATE_SERVICE: {
        return {
          ...baseContext,
          data: {
            readyForInput: true,
            prompt: "askServiceDetails",
          },
        };
      }

      // =========== ADMIN CREATE PROJECT ===========
      case INTENTS.ADMIN_CREATE_PROJECT: {
        const positions = await WorkPosition.find({ active: true })
          .select("_id title category")
          .lean();

        return {
          ...baseContext,
          data: {
            positions: positions.map((p) => ({
              id: p._id,
              title: p.title,
              category: p.category,
            })),
            positionCount: positions.length,
            readyForInput: true,
            prompt: "askProjectDetails",
          },
        };
      }

      // =========== SUPPORT ===========
      case INTENTS.SUPPORT_TICKET:
      case INTENTS.GENERAL_SUPPORT: {
        return {
          ...baseContext,
          data: {
            canCreateTicket: !!context.userId,
            supportEmail: (await getPublicSettingsObject()).support.supportEmail || null,
          },
        };
      }

      // =========== GREETINGS / GENERAL ===========
      case INTENTS.GREETING:
      case INTENTS.UNKNOWN:
      case INTENTS.CONFUSED:
      case INTENTS.CANCEL:
      case INTENTS.CONFIRM:
      default: {
        return {
          ...baseContext,
          data: {},
        };
      }
    }
  } catch (err) {
    console.error("[ContextBuilder] Error:", err.message);
    return {
      ...baseContext,
      data: { error: "Failed to load context" },
    };
  }
}

module.exports = {
  buildContext,
};
