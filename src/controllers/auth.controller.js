const User = require("../models/User");
const jwt = require("jsonwebtoken");
const bcryptjs = require("bcryptjs");

const { sendEmail } = require("../services/email.service");
const { welcomeEmail } = require("../emails/templates");
const { getFrontendUrl } = require("../config/frontendUrl");

// PATCH_54: Standardized error codes
const AUTH_ERRORS = {
  MISSING_FIELDS: {
    code: "MISSING_FIELDS",
    message: "All fields are required",
  },
  INVALID_EMAIL: {
    code: "INVALID_EMAIL",
    message: "Please enter a valid email address",
  },
  WEAK_PASSWORD: {
    code: "WEAK_PASSWORD",
    message:
      "Password must be at least 8 characters with uppercase, lowercase, number, and special character",
  },
  EMAIL_EXISTS: {
    code: "EMAIL_EXISTS",
    message: "An account with this email already exists",
  },
  PHONE_EXISTS: {
    code: "PHONE_EXISTS",
    message: "An account with this phone number already exists",
  },
  USER_NOT_FOUND: {
    code: "USER_NOT_FOUND",
    message: "Invalid email or password",
  },
  BAD_PASSWORD: { code: "BAD_PASSWORD", message: "Invalid email or password" },
  SERVER_ERROR: {
    code: "SERVER_ERROR",
    message: "An unexpected error occurred. Please try again.",
  },
  CONFIG_ERROR: { code: "CONFIG_ERROR", message: "Server configuration error" },
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    message: "Too many attempts. Please try again later.",
  },
};

// PATCH_54: Password strength validation
const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

const validatePassword = (password) => {
  if (!password || typeof password !== "string") return false;
  return PASSWORD_REGEX.test(password);
};

const validateEmail = (email) => {
  if (!email || typeof email !== "string") return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
};

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findUserByEmailInsensitive = async (email) => {
  const normalized = String(email || "").trim();
  if (!normalized) return null;
  // Case-insensitive exact match (supports legacy mixed-case stored emails).
  const re = new RegExp(`^${escapeRegExp(normalized)}$`, "i");
  return User.findOne({ email: re });
};

exports.signup = async (req, res, next) => {
  try {
    const { name, email, password, phone, referralCode } = req.body;

    // PATCH_54: Standardized validation
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.MISSING_FIELDS.code,
        message: AUTH_ERRORS.MISSING_FIELDS.message,
      });
    }

    // PATCH_54: Email validation
    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.INVALID_EMAIL.code,
        message: AUTH_ERRORS.INVALID_EMAIL.message,
      });
    }

    // PATCH_54: Strong password validation
    if (!validatePassword(password)) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.WEAK_PASSWORD.code,
        message: AUTH_ERRORS.WEAK_PASSWORD.message,
      });
    }

    const emailNormalized = String(email).trim().toLowerCase();

    // PATCH_54: Check for duplicate email
    const existingUser = await findUserByEmailInsensitive(emailNormalized);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.EMAIL_EXISTS.code,
        message: AUTH_ERRORS.EMAIL_EXISTS.message,
      });
    }

    // PATCH_54: Check for duplicate phone if provided
    if (phone) {
      const phoneNormalized = String(phone).replace(/\D/g, "");
      if (phoneNormalized.length >= 10) {
        const existingPhone = await User.findOne({ phone: phoneNormalized });
        if (existingPhone) {
          return res.status(400).json({
            success: false,
            code: AUTH_ERRORS.PHONE_EXISTS.code,
            message: AUTH_ERRORS.PHONE_EXISTS.message,
          });
        }
      }
    }

    // PATCH_23: Find referrer if referral code provided
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({
        referralCode: String(referralCode).trim().toUpperCase(),
      });
      if (referrer) {
        referredBy = referrer._id;
      }
    }

    const user = await User.create({
      name,
      email: emailNormalized,
      password,
      referredBy,
    });

    if (!process.env.JWT_SECRET) {
      console.error("[AUTH] FATAL: JWT_SECRET environment variable is not set");
      return res.status(500).json({
        success: false,
        code: AUTH_ERRORS.CONFIG_ERROR.code,
        message: AUTH_ERRORS.CONFIG_ERROR.message,
      });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, sessionVersion: user.sessionVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    // Email is best-effort; never block signup on email failure.
    setImmediate(async () => {
      try {
        await sendEmail({
          to: user.email,
          subject: "Welcome to UREMO",
          html: welcomeEmail({ name: user.name }),
        });
      } catch (err) {
        console.error("[email] welcome failed", {
          code: err?.code || "EMAIL_SEND_FAILED",
        });
      }
    });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        referralCode: user.referralCode,
        referredBy: user.referredBy || null,
      },
    });
  } catch (error) {
    console.error("[AUTH] signup error:", error.message);
    return res.status(500).json({
      success: false,
      code: AUTH_ERRORS.SERVER_ERROR.code,
      message: AUTH_ERRORS.SERVER_ERROR.message,
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // PATCH_54: Standardized error response
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.MISSING_FIELDS.code,
        message: "Email and password are required",
      });
    }

    const emailNormalized = String(email).trim().toLowerCase();
    const user = await findUserByEmailInsensitive(emailNormalized);
    if (!user) {
      return res.status(401).json({
        success: false,
        code: AUTH_ERRORS.USER_NOT_FOUND.code,
        message: AUTH_ERRORS.USER_NOT_FOUND.message,
      });
    }

    const isMatch = await bcryptjs.compare(String(password), user.password);
    if (!isMatch) {
      // Legacy compatibility: if a user was seeded with plaintext password,
      // allow one successful login and upgrade to bcrypt.
      if (
        typeof user.password === "string" &&
        !/^\$2[abxy]?\$/.test(user.password) &&
        user.password === String(password)
      ) {
        user.markModified("password");
        await user.save();
        console.info("[auth] upgraded legacy password storage");
      } else {
        return res.status(401).json({
          success: false,
          code: AUTH_ERRORS.BAD_PASSWORD.code,
          message: AUTH_ERRORS.BAD_PASSWORD.message,
        });
      }
    }

    if (!process.env.JWT_SECRET) {
      console.error("[AUTH] FATAL: JWT_SECRET environment variable is not set");
      return res.status(500).json({
        success: false,
        code: AUTH_ERRORS.CONFIG_ERROR.code,
        message: AUTH_ERRORS.CONFIG_ERROR.message,
      });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, sessionVersion: user.sessionVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    // PATCH_58: Update last login timestamp for engagement tracking
    try {
      const {
        updateLastLogin,
      } = require("../services/smartEngagement.service");
      await updateLastLogin(user._id);
    } catch (engErr) {
      console.warn("[AUTH] Failed to update lastLogin:", engErr.message);
    }

    res.json({
      success: true,
      token,
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("[AUTH] login error:", err.message);
    res.status(500).json({
      success: false,
      code: AUTH_ERRORS.SERVER_ERROR.code,
      message: AUTH_ERRORS.SERVER_ERROR.message,
    });
  }
};

// Secret-protected admin promotion endpoint.
// Enable by setting ADMIN_SETUP_SECRET in the environment.
// Call with header: x-admin-setup-secret: <secret>
// Body: { "email": "user@example.com" }
exports.makeAdmin = async (req, res) => {
  try {
    const secret = process.env.ADMIN_SETUP_SECRET;
    if (!secret) {
      return res.status(404).json({ message: "Route not found" });
    }

    const provided = req.headers["x-admin-setup-secret"];
    if (!provided || provided !== secret) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await findUserByEmailInsensitive(String(email).trim());
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.role = "admin";
    await user.save();

    return res.json({
      message: "User promoted to admin",
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server error" });
  }
};

// Secret-protected password reset endpoint.
// Enable by setting ADMIN_SETUP_SECRET in the environment.
// Call with header: x-admin-setup-secret: <secret>
// Body: { "email": "user@example.com", "newPassword": "..." }
exports.resetPasswordWithSecret = async (req, res) => {
  try {
    const secret = process.env.ADMIN_SETUP_SECRET;
    if (!secret) {
      return res.status(404).json({ message: "Route not found" });
    }

    const provided = req.headers["x-admin-setup-secret"];
    if (!provided || provided !== secret) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { email, password, newPassword } = req.body || {};
    const nextPassword =
      typeof newPassword === "string" && newPassword.length
        ? newPassword
        : password;

    if (!email || !nextPassword) {
      return res
        .status(400)
        .json({ message: "Email and newPassword are required" });
    }

    const user = await findUserByEmailInsensitive(String(email).trim());
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!await changePassword({ _id: user._id }, String(nextPassword))) return res.status(404).json({ message: "User not found" });

    return res.json({
      message: "Password updated",
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Server error" });
  }
};

/**
 * Get current user profile
 * GET /api/auth/me
 */
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const user = await User.findById(userId).select("-password -__v");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        referralCode: user.referralCode,
        affiliateBalance: user.affiliateBalance || 0,
        totalAffiliateEarned: user.totalAffiliateEarned || 0,
        walletBalance: user.walletBalance || 0,
        // PATCH_34: Onboarding fields
        onboardingCompleted: user.onboardingCompleted || false,
        interestCategory: user.interestCategory || "general",
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "Server error" });
  }
};

/**
 * PATCH_34: Update user onboarding status
 * PUT /api/auth/onboarding
 */
exports.updateOnboarding = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res
        .status(401)
        .json({ ok: false, message: "Authentication required" });
    }

    const { interestCategory } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // Validate category
    const validCategories = [
      "microjobs",
      "forex_crypto",
      "banks_wallets",
      "general",
    ];
    user.interestCategory = validCategories.includes(interestCategory)
      ? interestCategory
      : "general";
    user.onboardingCompleted = true;

    await user.save();

    res.json({
      ok: true,
      message: "Onboarding completed",
      user: {
        onboardingCompleted: user.onboardingCompleted,
        interestCategory: user.interestCategory,
      },
    });
  } catch (error) {
    console.error("[Auth] updateOnboarding error:", error);
    res
      .status(500)
      .json({ ok: false, message: error.message || "Server error" });
  }
};

/**
 * PATCH_54: Forgot Password - Request password reset
 * POST /api/auth/forgot-password
 */
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        code: "MISSING_FIELDS",
        message: "Email is required",
      });
    }

    const emailNormalized = String(email).trim().toLowerCase();
    const user = await findUserByEmailInsensitive(emailNormalized);

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({
        success: true,
        message:
          "If an account exists with this email, you will receive a password reset link.",
      });
    }

    // Generate reset token
    const crypto = require("crypto");
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.passwordResetToken = resetTokenHash;
    user.passwordResetExpires = resetExpiry;
    await user.save();

    // Send reset email (best effort)
    try {
      const resetUrl = `${getFrontendUrl()}/reset-password?token=${resetToken}`;
      await sendEmail({
        to: user.email,
        subject: "Password Reset Request - UREMO",
        html: `
          <h2>Password Reset</h2>
          <p>You requested a password reset for your UREMO account.</p>
          <p>Click the link below to reset your password (valid for 1 hour):</p>
          <p><a href="${resetUrl}" style="background: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a></p>
          <p>If you didn't request this, please ignore this email.</p>
        `,
      });
    } catch (emailErr) {
      console.error("[AUTH] Password reset email failed:", emailErr.message);
    }

    res.json({
      success: true,
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  } catch (error) {
    console.error("[AUTH] forgotPassword error:", error);
    res.status(500).json({
      success: false,
      code: AUTH_ERRORS.SERVER_ERROR.code,
      message: AUTH_ERRORS.SERVER_ERROR.message,
    });
  }
};

/**
 * PATCH_54: Reset Password - Set new password with token
 * POST /api/auth/reset-password
 */
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (typeof token !== "string" || !token || !password) {
      return res.status(400).json({
        success: false,
        code: "MISSING_FIELDS",
        message: "Token and new password are required",
      });
    }

    // Validate password strength
    if (!validatePassword(password)) {
      return res.status(400).json({
        success: false,
        code: AUTH_ERRORS.WEAK_PASSWORD.code,
        message: AUTH_ERRORS.WEAK_PASSWORD.message,
      });
    }

    // Hash the token for comparison
    const crypto = require("crypto");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const filter = {
      passwordResetToken: tokenHash,
      passwordResetExpires: { $gt: new Date() },
    };

    // Avoid password hashing for unrelated/expired tokens. The update rechecks
    // the same single-use token so simultaneous requests cannot both succeed.
    if (!await User.exists(filter) || !await changePassword(filter, password)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "Password reset link is invalid or has expired",
      });
    }

    res.json({
      success: true,
      message: "Password has been reset successfully. You can now log in.",
    });
  } catch (error) {
    console.error("[AUTH] resetPassword error:", error);
    res.status(500).json({
      success: false,
      code: AUTH_ERRORS.SERVER_ERROR.code,
      message: AUTH_ERRORS.SERVER_ERROR.message,
    });
  }
};

async function changePassword(filter, password) {
  const hash = await bcryptjs.hash(password, 10);
  if (filter.passwordResetExpires) filter.passwordResetExpires = { $gt: new Date() };
  const result = await User.updateOne(filter, {
    $set: { password: hash },
    $unset: { passwordResetToken: "", passwordResetExpires: "" },
    $inc: { sessionVersion: 1 },
  });
  return result.modifiedCount === 1;
}
