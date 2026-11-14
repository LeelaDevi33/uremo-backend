const express = require("express");
const rateLimit = require("../middlewares/rateLimit");
const {
  signup,
  login,
  makeAdmin,
  resetPasswordWithSecret,
  getProfile,
  updateOnboarding,
  forgotPassword,
  resetPassword,
} = require("../controllers/auth.controller");
const auth = require("../middlewares/auth.middleware");

const router = express.Router();

// PATCH_54: Rate limiters for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many attempts. Please try again in 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 signups per hour per IP
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many signup attempts. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many password reset requests. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/signup", signupLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/forgot-password", forgotPasswordLimiter, forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/make-admin", makeAdmin);
router.post("/setup/reset-password", resetPasswordWithSecret);
router.get("/me", auth, getProfile);
router.get("/profile", auth, getProfile);
// PATCH_34: Onboarding wizard endpoint
router.put("/onboarding", auth, updateOnboarding);

module.exports = router;
