const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const User = require("../models/User");
const rateLimit = require("express-rate-limit");

const VALID_INTERESTS = ["microjobs", "rentals", "project_purchase", "forex", "wallets", "crypto"];
const MAX_INTERESTS = 10;
const MAX_TAG_LENGTH = 50;
const VALID_PREF_KEYS = [
  "productUpdates",
  "jobAlerts",
  "dealAlerts",
  "rentalAlerts",
  "marketing",
];

const logger = {
  info: (msg) =>
    console.log(`[USER_PREFS_INFO] ${new Date().toISOString()} ${msg}`),
  error: (msg) =>
    console.error(`[USER_PREFS_ERROR] ${new Date().toISOString()} ${msg}`),
};

const prefLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Too many preference updates, please try again later",
  },
  skip: (req) => !req.user,
});

/**
 * PATCH_53: User Preferences Routes
 */

/**
 * GET /api/users/preferences
 * Get current user's email preferences and interests
 */
router.get("/preferences", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "emailPreferences interestTags",
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    logger.info(`Preferences fetched for user ${req.user.id}`);

    res.json({
      success: true,
      data: {
        emailPreferences: user.emailPreferences || {},
        interestTags: user.interestTags || [],
      },
    });
  } catch (error) {
    logger.error(`Get preferences failed: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to fetch preferences",
    });
  }
});

/**
 * PUT /api/users/preferences
 * Update user's email preferences and interests
 */
router.put("/preferences", auth, prefLimiter, async (req, res) => {
  try {
    const { emailPreferences, interestTags } = req.body;

    if (emailPreferences && typeof emailPreferences !== "object") {
      return res.status(400).json({
        success: false,
        message: "emailPreferences must be an object",
      });
    }

    if (interestTags && !Array.isArray(interestTags)) {
      return res.status(400).json({
        success: false,
        message: "interestTags must be an array",
      });
    }

    if (emailPreferences) {
      for (const key in emailPreferences) {
        if (!VALID_PREF_KEYS.includes(key)) {
          return res.status(400).json({
            success: false,
            message: `Invalid preference key: ${key}`,
          });
        }
        if (typeof emailPreferences[key] !== "boolean") {
          return res.status(400).json({
            success: false,
            message: `Preference ${key} must be boolean`,
          });
        }
      }
    }

    if (interestTags) {
      if (interestTags.length > MAX_INTERESTS) {
        return res.status(400).json({
          success: false,
          message: `Cannot have more than ${MAX_INTERESTS} interests`,
        });
      }

      for (const tag of interestTags) {
        if (typeof tag !== "string") {
          return res.status(400).json({
            success: false,
            message: "All tags must be strings",
          });
        }
        if (tag.length > MAX_TAG_LENGTH) {
          return res.status(400).json({
            success: false,
            message: `Tag exceeds ${MAX_TAG_LENGTH} characters`,
          });
        }
        if (!VALID_INTERESTS.includes(tag.toLowerCase())) {
          return res.status(400).json({
            success: false,
            message: `Invalid interest tag: ${tag}. Valid: ${VALID_INTERESTS.join(", ")}`,
          });
        }
      }
    }

    const updateData = {};
    if (emailPreferences) {
      updateData.emailPreferences = emailPreferences;
    }
    if (interestTags) {
      updateData.interestTags = interestTags.map((t) =>
        String(t).toLowerCase().trim(),
      );
    }

    const user = await User.findByIdAndUpdate(req.user.id, updateData, {
      new: true,
    }).select("emailPreferences interestTags");

    logger.info(`Preferences updated for user ${req.user.id}`);

    res.json({
      success: true,
      message: "Preferences updated successfully",
      data: {
        emailPreferences: user.emailPreferences,
        interestTags: user.interestTags,
      },
    });
  } catch (error) {
    logger.error(`Update preferences failed: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to update preferences",
    });
  }
});

module.exports = router;
