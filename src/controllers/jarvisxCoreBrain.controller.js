/**
 * UREMO JarvisX Controller - Core Brain Architecture
 *
 * UNIFIED CHAT SYSTEM:
 * - All requests route through Core Brain (coreBrain.js)
 * - All sessions stored in MongoDB (JarvisSession)
 * - Groq LLM only used for reasoning (never talks to users)
 * - All responses pass through Core Brain tone/safety filters
 *
 * Architecture:
 * User → Frontend → Backend → JarvisX Gateway → Core Brain → Groq → Core Brain → Response
 */

const JarvisSession = require("../models/JarvisSession");
const JarvisAuditLog = require("../models/JarvisAuditLog");
const CoreBrain = require("../jarvisx/coreBrain");
const {
  sanitizeInput,
  sanitizeOutput,
  detectInjection,
} = require("../jarvisx/injectionSanitizer");
const crypto = require("crypto");

// ============================================
// UTILITIES
// ============================================

/**
 * Clamp string to max length
 */
function clampString(value, maxLen = 1200) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  return v.length <= maxLen ? v : v.slice(0, maxLen);
}

/**
 * Get client IP (hashed for privacy)
 */
function getClientIpHash(req) {
  const xf = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  const first = typeof raw === "string" ? raw.split(",")[0].trim() : "";
  const ip = first || req.ip || req.connection?.remoteAddress || "";

  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Get user agent summary
 */
function getUserAgentSummary(req) {
  const ua = req.headers["user-agent"] || "";
  return ua.slice(0, 200);
}

/**
 * Generate request ID for correlation
 */
function generateRequestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Get LLM status for response
 */
function getLlmStatus() {
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  return {
    configured: !!apiKey,
    provider: "groq",
    model: process.env.JARVISX_MODEL || "llama-3.3-70b-versatile",
  };
}

// ============================================
// MAIN CHAT HANDLER (UNIFIED)
// ============================================

/**
 * Unified chat handler - ALL chat requests go through this
 * Routes to Core Brain for processing
 */
async function chat(req, res) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  try {
    // 1. Extract and validate message
    const rawMessage = req.body?.message;
    const message = clampString(rawMessage, 1200);

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Message is required",
        requestId,
      });
    }

    // 2. Check for prompt injection BEFORE processing
    const injectionCheck = detectInjection(message);
    if (injectionCheck.isInjection && injectionCheck.severity === "high") {
      // Log the security event
      await JarvisAuditLog.logAction({
        actionType: "INJECTION_BLOCKED",
        role: JarvisSession.determineRole(req),
        userInput: message.slice(0, 100),
        status: "blocked",
        errorMessage: `Injection detected: ${injectionCheck.pattern}`,
        requestId,
        ipHash: getClientIpHash(req),
      });

      return res.status(400).json({
        success: false,
        error: "Invalid message format",
        requestId,
      });
    }

    // 3. Sanitize input
    const sanitizedInput = sanitizeInput(message);
    const sanitizedMessage = sanitizedInput.text || "";

    // 4. Get or create session
    const session = await JarvisSession.getOrCreateSession(req);

    // 5. Set session cookie for anonymous users
    if (req._jarvisxNewSid) {
      res.cookie("jarvisx_sid", req._jarvisxNewSid, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 2 * 60 * 60 * 1000, // 2 hours
      });
    }

    // 6. Build context for Core Brain
    const context = {
      userId: req.user?._id || req.user?.id || null,
      role: session.role,
      isAdmin: session.isAdmin,
      sessionId: session._id,
      session: session,
      requestId: requestId,
    };

    // 7. Add user message to history
    await session.addMessage("user", sanitizedMessage, {
      intent: null, // Will be classified by Core Brain
    });

    // 8. Process through Core Brain
    const result = await CoreBrain.process({
      message: sanitizedMessage,
      session,
      context,
      userId: context.userId,
      role: session.role,
    });

    // 9. Sanitize output before returning
    const replyText = result?.response?.message || "";
    const safeResponse = sanitizeOutput(replyText);

    // 10. Add assistant message to history
    await session.addMessage("assistant", safeResponse, {
      intent: result.intent,
      toolUsed: result.toolUsed || null,
    });

    // 11. Update session state if Core Brain changed it
    if (result.flow) session.flow = result.flow;
    if (result.step) session.step = result.step;
    if (result.collectedData) {
      session.collectedData = {
        ...session.collectedData,
        ...result.collectedData,
      };
    }
    session.lastIntent = result.intent;
    session.lastAction = result.toolUsed || null;
    await session.save();

    // 12. Log the action
    await JarvisAuditLog.logAction({
      sessionId: session._id,
      userId: context.userId,
      role: session.role,
      actionType: result.toolUsed ? "TOOL_EXECUTE" : "CHAT_MESSAGE",
      intent: result.intent,
      toolUsed: result.toolUsed,
      userInput: sanitizedMessage.slice(0, 100),
      responseSummary: safeResponse.slice(0, 100),
      status: "success",
      processingTimeMs: Date.now() - startTime,
      requestId,
      ipHash: getClientIpHash(req),
      userAgent: getUserAgentSummary(req),
    });

    // 13. Build response
    const response = {
      success: true,
      reply: safeResponse,
      intent: result.intent,
      confidence: result.confidence || 0.9,
      quickReplies: result.quickReplies || [],
      suggestedActions: result.suggestedActions || [],
      llm: getLlmStatus(),
      meta: {
        sessionId: session._id.toString(),
        flow: session.flow,
        step: session.step,
        processingTime: Date.now() - startTime,
        version: "CORE_BRAIN_v1",
      },
    };

    console.log(
      `[JARVISX] ${session.role} | intent=${result.intent} | tool=${result.toolUsed || "none"} | ${Date.now() - startTime}ms`,
    );

    return res.json(response);
  } catch (error) {
    console.error(
      `[JARVISX_ERROR] requestId=${requestId} error=${error.message}`,
    );

    // Log error
    await JarvisAuditLog.logAction({
      actionType: "LLM_ERROR",
      role: JarvisSession.determineRole(req),
      status: "failure",
      errorMessage: error.message,
      processingTimeMs: Date.now() - startTime,
      requestId,
    });

    return res.status(500).json({
      success: false,
      error: "I'm having trouble processing your request. Please try again.",
      requestId,
    });
  }
}

// ============================================
// ADMIN COMMAND HANDLER
// ============================================

/**
 * Handle admin commands with authoritative execution
 * Example: "show pending orders", "get user stats", "update order #123 status to completed"
 */
async function adminCommand(req, res) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  try {
    // 1. Verify admin role
    if (req.user?.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Admin access required",
        requestId,
      });
    }

    // 2. Extract command
    const rawCommand = req.body?.command || req.body?.message;
    const command = clampString(rawCommand, 500);

    if (!command) {
      return res.status(400).json({
        success: false,
        error: "Command is required",
        requestId,
      });
    }

    // 3. Get session
    const session = await JarvisSession.getOrCreateSession(req);

    // 4. Build admin context
    const context = {
      userId: req.user._id || req.user.id,
      role: "admin",
      isAdmin: true,
      sessionId: session._id,
      session: session,
      requestId: requestId,
    };

    // 5. Parse and execute admin command through Core Brain
    const result = await CoreBrain.executeAdminCommand(command, context);

    // 6. Log the admin action
    await JarvisAuditLog.logAction({
      sessionId: session._id,
      userId: context.userId,
      role: "admin",
      actionType: "ADMIN_COMMAND",
      intent: "ADMIN_ACTION",
      toolUsed: result.toolUsed,
      userInput: command,
      responseSummary: result.response?.slice(0, 100),
      toolParams: result.toolParams,
      status: result.success ? "success" : "failure",
      errorMessage: result.error || null,
      processingTimeMs: Date.now() - startTime,
      requestId,
      ipHash: getClientIpHash(req),
    });

    return res.json({
      success: result.success,
      response: result.response,
      data: result.data || null,
      toolUsed: result.toolUsed,
      meta: {
        processingTime: Date.now() - startTime,
        requestId,
      },
    });
  } catch (error) {
    console.error(
      `[JARVISX_ADMIN_ERROR] requestId=${requestId} error=${error.message}`,
    );

    await JarvisAuditLog.logAction({
      actionType: "ADMIN_COMMAND",
      role: "admin",
      status: "failure",
      errorMessage: error.message,
      requestId,
    });

    return res.status(500).json({
      success: false,
      error: "Failed to execute command",
      requestId,
    });
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

/**
 * Get current session state
 */
async function getSession(req, res) {
  try {
    const session = await JarvisSession.getOrCreateSession(req);

    // Set cookie if new
    if (req._jarvisxNewSid) {
      res.cookie("jarvisx_sid", req._jarvisxNewSid, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 2 * 60 * 60 * 1000,
      });
    }

    return res.json({
      success: true,
      session: {
        id: session._id.toString(),
        role: session.role,
        flow: session.flow,
        step: session.step,
        lastIntent: session.lastIntent,
        messageCount: session.stats?.messageCount || 0,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    console.error(`[JARVISX_SESSION_ERROR] ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Failed to get session",
    });
  }
}

/**
 * Reset session state (but keep history)
 */
async function resetSession(req, res) {
  try {
    const session = await JarvisSession.getOrCreateSession(req);
    await session.resetState();

    return res.json({
      success: true,
      message: "Session state reset",
    });
  } catch (error) {
    console.error(`[JARVISX_RESET_ERROR] ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Failed to reset session",
    });
  }
}

/**
 * Get session history
 */
async function getHistory(req, res) {
  try {
    const session = await JarvisSession.getOrCreateSession(req);
    const limit = Math.min(parseInt(req.query?.limit) || 20, 50);

    return res.json({
      success: true,
      messages: session.messages.slice(-limit).map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });
  } catch (error) {
    console.error(`[JARVISX_HISTORY_ERROR] ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Failed to get history",
    });
  }
}

// ============================================
// HEALTH & DIAGNOSTICS
// ============================================

/**
 * Health check endpoint
 */
async function health(req, res) {
  const llmStatus = getLlmStatus();

  // Check MongoDB connection
  const mongoose = require("mongoose");
  const dbStatus =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";

  return res.json({
    status: "ok",
    version: "CORE_BRAIN_v1",
    timestamp: new Date().toISOString(),
    llm: {
      configured: llmStatus.configured,
      provider: llmStatus.provider,
      model: llmStatus.model,
    },
    database: dbStatus,
    architecture: "CORE_BRAIN_CENTRIC",
  });
}

/**
 * Detailed health report (admin only)
 */
async function healthReport(req, res) {
  try {
    // Verify admin
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Admin required" });
    }

    const llmStatus = getLlmStatus();
    const mongoose = require("mongoose");

    // Get session stats
    const sessionStats = await JarvisSession.aggregate([
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 },
          avgMessages: { $avg: "$stats.messageCount" },
        },
      },
    ]);

    // Get recent audit stats
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const auditStats = await JarvisAuditLog.aggregate([
      { $match: { createdAt: { $gte: last24h } } },
      {
        $group: {
          _id: "$actionType",
          count: { $sum: 1 },
          avgTime: { $avg: "$processingTimeMs" },
        },
      },
    ]);

    // Get security events
    const securityEvents = await JarvisAuditLog.getSecurityEvents(10);

    return res.json({
      success: true,
      status: "healthy",
      version: "CORE_BRAIN_v1",
      timestamp: new Date().toISOString(),
      llm: llmStatus,
      database: {
        status:
          mongoose.connection.readyState === 1 ? "connected" : "disconnected",
        host: mongoose.connection.host,
      },
      sessions: sessionStats,
      audit24h: auditStats,
      recentSecurityEvents: securityEvents.length,
    });
  } catch (error) {
    console.error(`[JARVISX_HEALTH_ERROR] ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Health check failed",
    });
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Main handlers
  chat,
  adminCommand,

  // Session management
  getSession,
  resetSession,
  getHistory,

  // Health
  health,
  healthReport,
};
