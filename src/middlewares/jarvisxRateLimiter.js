/**
 * UREMO Rate Limiter Middleware - API Protection
 *
 * SECURITY ENFORCEMENT:
 * - Rate limit all JarvisX endpoints
 * - Prevent abuse and DoS
 * - Different limits for different endpoints
 */

const rateLimit = require("./rateLimit");

// =============================================================================
// RATE LIMIT CONFIGURATIONS
// =============================================================================

/**
 * Standard JarvisX rate limiter
 * 60 requests per minute per IP
 */
const jarvisxLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    response: {
      message: "Too many requests. Please wait a moment before trying again.",
      actions: [],
    },
    meta: {
      code: "RATE_LIMITED",
      retryAfter: 60,
    },
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === "/health" || req.path === "/v2/health";
  },
  handler: (req, res, next, options) => {
    console.warn("[RateLimiter] Rate limit exceeded:", {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString(),
    });
    res.status(429).json(options.message);
  },
});

/**
 * Strict rate limiter for chat endpoints
 * 30 requests per minute per IP
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    response: {
      message: "You are sending messages too quickly. Please slow down.",
      actions: [],
    },
    meta: {
      code: "RATE_LIMITED",
      retryAfter: 60,
    },
  },
  handler: (req, res, next, options) => {
    console.warn("[RateLimiter] Chat rate limit exceeded:", {
      ip: req.ip,
      userId: req.user?.id,
      path: req.path,
      timestamp: new Date().toISOString(),
    });
    res.status(429).json(options.message);
  },
});

/**
 * Admin endpoint rate limiter
 * More lenient for admin operations
 * 120 requests per minute
 */
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    response: {
      message: "Rate limit reached. Please wait before making more requests.",
      actions: [],
    },
    meta: {
      code: "RATE_LIMITED",
      retryAfter: 60,
    },
  },
});

/**
 * Burst limiter for sudden traffic spikes
 * 10 requests per 10 seconds
 */
const burstLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 10, // 10 requests per 10 seconds
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    response: {
      message: "Slow down. You are making requests too quickly.",
      actions: [],
    },
    meta: {
      code: "RATE_LIMITED",
      retryAfter: 10,
    },
  },
});

// =============================================================================
// CUSTOM MIDDLEWARE
// =============================================================================

/**
 * Request logging middleware for JarvisX
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      userId: req.user?.id || "anonymous",
      ip: req.ip,
      timestamp: new Date().toISOString(),
    };

    // Log all requests (can be adjusted for production)
    if (process.env.JARVISX_REQUEST_LOGGING === "true") {
      console.log("[JarvisX Request]", JSON.stringify(logData));
    }

    // Always log errors
    if (res.statusCode >= 400) {
      console.warn("[JarvisX Error]", JSON.stringify(logData));
    }
  });

  next();
}

/**
 * Security headers middleware
 */
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // No caching for API responses
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private",
  );
  res.setHeader("Pragma", "no-cache");

  next();
}

/**
 * Combined JarvisX security middleware
 * Apply this to all JarvisX routes
 */
function jarvisxSecurityMiddleware(req, res, next) {
  // Apply security headers
  securityHeaders(req, res, () => {
    // Apply request logging
    requestLogger(req, res, () => {
      next();
    });
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  jarvisxLimiter,
  chatLimiter,
  adminLimiter,
  burstLimiter,
  requestLogger,
  securityHeaders,
  jarvisxSecurityMiddleware,
};
