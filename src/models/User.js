const mongoose = require("mongoose");
const bcryptjs = require("bcryptjs");
const crypto = require("crypto");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: { type: String, required: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },

    // PATCH_23: Affiliate / Referral fields
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    affiliateBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAffiliateEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // PATCH_23: Internal Wallet Balance
    // PATCH_110: Wallet as Single Source of Truth
    walletBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    withdrawable: {
      type: Number,
      default: 0,
      min: 0,
    },
    pendingWithdrawals: {
      type: Number,
      default: 0,
      min: 0,
    },
    lifetimeEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastWalletUpdate: {
      type: Date,
      default: null,
    },

    // PATCH_34: Onboarding wizard fields
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    interestCategory: {
      type: String,
      enum: ["microjobs", "forex_crypto", "banks_wallets", "general"],
      default: "general",
    },

    // PATCH_53: Email preferences and interests for engagement
    emailPreferences: {
      productUpdates: { type: Boolean, default: true },
      jobAlerts: { type: Boolean, default: true },
      dealAlerts: { type: Boolean, default: true },
      rentalAlerts: { type: Boolean, default: true },
      marketing: { type: Boolean, default: false },
    },

    interestTags: {
      type: [String],
      default: [],
      // e.g., ["microjobs", "forex", "wallets", "crypto", "rentals"]
    },

    // PATCH_54: Password reset fields
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    sessionVersion: { type: Number, default: 0 },

    // PATCH_54: Phone number for duplicate prevention
    phone: {
      type: String,
      sparse: true,
      index: true,
    },

    // PATCH_58: Smart Engagement Engine tracking
    lastEngagementEmail: {
      type: Date,
      default: null,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    engagementNudges: {
      signupNudgeSent: { type: Boolean, default: false },
      screeningNudgeSent: { type: Boolean, default: false },
      lastNudgeType: { type: String, default: null },
      lastNudgeAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// PATCH_23: Generate unique referral code before save
userSchema.pre("save", async function () {
  // Generate referral code if not set
  if (!this.referralCode) {
    // Generate a short unique code: first 3 chars of name + random 5 chars
    const namePart = (this.name || "user")
      .replace(/[^a-zA-Z]/g, "")
      .substring(0, 3)
      .toUpperCase();
    const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();
    this.referralCode = `${namePart}${randomPart}`;
  }

  if (!this.isModified("password")) return;
  this.password = await bcryptjs.hash(this.password, 10);
});

module.exports = mongoose.model("User", userSchema);
