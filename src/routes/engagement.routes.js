/**
 * PATCH_58: Smart Engagement Routes
 * API endpoints for engagement system
 */

const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth.middleware");
const adminAuth = require("../middlewares/admin.middleware");
const {
  runEngagementCycle,
  processSignupNudge,
  processScreeningNudge,
  notifyReadyWorkers,
} = require("../services/smartEngagement.service");

/**
 * POST /api/engagement/run-cycle
 * Manually trigger engagement cycle (admin only)
 */
router.post("/run-cycle", auth, adminAuth, async (req, res) => {
  try {
    const results = await runEngagementCycle();
    res.json({
      success: true,
      message: "Engagement cycle completed",
      results,
    });
  } catch (error) {
    console.error("[engagement] run-cycle failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to run engagement cycle",
      error: error.message,
    });
  }
});

/**
 * POST /api/engagement/signup-nudge
 * Process signup nudges only (admin only)
 */
router.post("/signup-nudge", auth, adminAuth, async (req, res) => {
  try {
    const results = await processSignupNudge();
    res.json({
      success: true,
      message: "Signup nudge processing completed",
      results,
    });
  } catch (error) {
    console.error("[engagement] signup-nudge failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to process signup nudges",
      error: error.message,
    });
  }
});

/**
 * POST /api/engagement/screening-nudge
 * Process screening nudges only (admin only)
 */
router.post("/screening-nudge", auth, adminAuth, async (req, res) => {
  try {
    const results = await processScreeningNudge();
    res.json({
      success: true,
      message: "Screening nudge processing completed",
      results,
    });
  } catch (error) {
    console.error("[engagement] screening-nudge failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to process screening nudges",
      error: error.message,
    });
  }
});

/**
 * POST /api/engagement/notify-ready-workers
 * Notify ready workers about new job (internal/webhook use)
 */
router.post("/notify-ready-workers", auth, adminAuth, async (req, res) => {
  try {
    const { jobTitle, jobCategory, jobId } = req.body;

    if (!jobTitle) {
      return res.status(400).json({
        success: false,
        message: "jobTitle is required",
      });
    }

    const results = await notifyReadyWorkers(jobTitle, jobCategory, jobId);
    res.json({
      success: true,
      message: "Ready workers notified",
      results,
    });
  } catch (error) {
    console.error("[engagement] notify-ready-workers failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to notify ready workers",
      error: error.message,
    });
  }
});

/**
 * POST /api/engagement/notify-interested-users
 * Notify users interested in a new service (internal/webhook use)
 */
router.post("/notify-interested-users", auth, adminAuth, require("../middlewares/retiredCatalog"));

/**
 * GET /api/engagement/status
 * Get engagement system status (admin only)
 */
router.get("/status", auth, adminAuth, async (req, res) => {
  try {
    const User = require("../models/User");
    const Notification = require("../models/Notification");

    const [
      totalUsers,
      usersWithNudges,
      recentNotifications,
      usersWithEngagementEmail,
    ] = await Promise.all([
      User.countDocuments({ role: "user" }),
      User.countDocuments({ "engagementNudges.signupNudgeSent": true }),
      Notification.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
      User.countDocuments({
        lastEngagementEmail: {
          $gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
        },
      }),
    ]);

    res.json({
      success: true,
      status: {
        totalUsers,
        usersWithNudges,
        recentNotifications24h: recentNotifications,
        usersEmailedLast48h: usersWithEngagementEmail,
        minEmailIntervalHours: 48,
        signupNudgeDelayHours: 48,
        screeningNudgeDelayHours: 24,
      },
    });
  } catch (error) {
    console.error("[engagement] status failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to get engagement status",
      error: error.message,
    });
  }
});

module.exports = router;
