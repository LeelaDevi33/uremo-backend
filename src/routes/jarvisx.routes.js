const { tokenIdentity } = require("../services/tokenIdentity");
/**
 * JarvisX Routes - Core Brain Architecture
 *
 * UNIFIED ROUTING:
 * - All chat goes through Core Brain controller
 * - Rate limiting applied at route level
 * - Admin commands have dedicated endpoint
 * - V1/V2 kept for backward compatibility (deprecated)
 *
 * Architecture:
 * User → Routes → Rate Limiter → Auth → Core Brain Controller → Core Brain → Response
 */
const express = require("express");
const router = express.Router();

// Controllers
const retiredCatalog = require("../middlewares/retiredCatalog");
const JarvisX = require("../controllers/jarvisx.controller"); // Legacy
const JarvisXCoreBrain = require("../controllers/jarvisxCoreBrain.controller"); // New

// Middleware
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const {
  adminLimiter,
  requestLogger,
  securityHeaders,
} = require("../middlewares/jarvisxRateLimiter");

// Optional auth - attaches user if token present but doesn't require it
const optionalAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1] || req.cookies?.token;
  if (!token) {
    return next();
  }

  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await tokenIdentity(decoded);
  } catch (e) {
    // Invalid token - continue as guest
  }
  next();
};

// ============================================================
// CORE BRAIN ENDPOINTS (Unified - Primary)
// ============================================================

// Health check (no auth required)
router.get("/health", JarvisXCoreBrain.health);

// The legacy assistant can create service requests and recommend retired listings.
router.post("/chat", securityHeaders, requestLogger, adminLimiter, auth, admin, JarvisXCoreBrain.chat);

// Session management
router.get("/session", optionalAuth, JarvisXCoreBrain.getSession);
router.post("/session/reset", optionalAuth, JarvisXCoreBrain.resetSession);
router.get("/history", optionalAuth, JarvisXCoreBrain.getHistory);

// Admin command endpoint (admin auth required)
router.post(
  "/admin/command",
  securityHeaders,
  requestLogger,
  adminLimiter,
  auth,
  admin,
  JarvisXCoreBrain.adminCommand,
);

// Admin health report (admin auth required)
router.get("/admin/health", auth, admin, JarvisXCoreBrain.healthReport);

// ============================================================
// V1 ENDPOINTS (Legacy - Deprecated but kept for compatibility)
// ============================================================
router.get("/public-context", retiredCatalog);
router.post("/v1/chat", retiredCatalog);
router.post("/request-service", retiredCatalog);

// Admin endpoints (auth + admin required)
router.get("/admin-context", auth, admin, JarvisX.getAdminContext);

// ============================================================
// V2 ENDPOINTS (Deprecated - Use Core Brain /chat instead)
// ============================================================
// Kept for backward compatibility during transition
router.post("/v2/chat", retiredCatalog);
router.post("/v2/action", retiredCatalog);
router.get("/v2/health", JarvisX.healthV2);

module.exports = router;
