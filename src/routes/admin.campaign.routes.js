const express = require("express");
const router = express.Router();
const engagementService = require("../services/engagement.service");
const rateLimit = require("../middlewares/rateLimit");
const adminMiddleware = require("../middlewares/admin.middleware");

const logger = {
  info: (msg) =>
    console.log(`[ADMIN_CAMPAIGN_INFO] ${new Date().toISOString()} ${msg}`),
  error: (msg) =>
    console.error(`[ADMIN_CAMPAIGN_ERROR] ${new Date().toISOString()} ${msg}`),
};

const campaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Campaign creation rate limit exceeded" },
  standardHeaders: true,
  skip: (req) => !req.user || req.user.role !== "admin",
});

const MAX_CAMPAIGN_TITLE = 500;
const MAX_CAMPAIGN_MESSAGE = 5000;
const VALID_INTERESTS = ["microjobs", "rentals", "project_purchase"];

/**
 * PATCH_53: Admin Campaign Routes
 */

/**
 * POST /api/admin/campaigns/send
 * Send a campaign to users matching interest tags
 * Admin only
 */
router.post("/send", adminMiddleware, campaignLimiter, async (req, res) => {
  try {
    const { title, message, targetTags } = req.body;

    if (
      !title ||
      !message ||
      typeof title !== "string" ||
      typeof message !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required and must be strings",
      });
    }

    if (title.length > MAX_CAMPAIGN_TITLE) {
      return res.status(400).json({
        success: false,
        message: `Title exceeds ${MAX_CAMPAIGN_TITLE} characters`,
      });
    }

    if (message.length > MAX_CAMPAIGN_MESSAGE) {
      return res.status(400).json({
        success: false,
        message: `Message exceeds ${MAX_CAMPAIGN_MESSAGE} characters`,
      });
    }

    if (targetTags && !Array.isArray(targetTags)) {
      return res.status(400).json({
        success: false,
        message: "targetTags must be an array",
      });
    }

    if (targetTags && targetTags.length > 0) {
      for (const tag of targetTags) {
        if (!VALID_INTERESTS.includes(String(tag).toLowerCase())) {
          return res.status(400).json({
            success: false,
            message: `Invalid target tag: ${tag}. Valid: ${VALID_INTERESTS.join(", ")}`,
          });
        }
      }
    }

    const idempotencyKey = `campaign_${req.user.id}_${Date.now()}`;

    const event = await engagementService.queueEvent({
      type: "campaign",
      title,
      message,
      targetTags: targetTags || [],
      idempotencyKey,
    });

    logger.info(`Campaign created by admin ${req.user.id}: event=${event._id}`);

    res.status(201).json({
      success: true,
      message: "Campaign queued successfully",
      data: {
        eventId: event._id,
        type: event.type,
        targetTags: event.targetTags,
        idempotencyKey,
      },
    });
  } catch (error) {
    logger.error(`Campaign creation failed: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to send campaign",
    });
  }
});

/**
 * GET /api/admin/campaigns/events
 * Get all engagement events (admin dashboard)
 */
router.get("/events", adminMiddleware, async (req, res) => {
  try {
    const EngagementEvent = require("../models/EngagementEvent");
    const { limit = 50, page = 1 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const skip = (parsedPage - 1) * parsedLimit;

    const events = await EngagementEvent.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean();

    const total = await EngagementEvent.countDocuments();

    logger.info(
      `Events fetched by admin ${req.user.id}: returned ${events.length}/${total}`,
    );

    res.json({
      success: true,
      data: events,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (error) {
    logger.error(`Failed to fetch events: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Failed to fetch events",
    });
  }
});

module.exports = router;
