const express = require("express");
const router = express.Router();

const { paymentPendingReminders } = require("../controllers/cron.controller");
// PATCH_22: Rental expiry job
const { expireRentalsJob } = require("../controllers/rentals.controller");
// PATCH_53: Engagement batch processor
const { runEngagementBatch } = require("../cron/engagement.cron");
// PATCH_58: Smart Engagement Engine
const { runEngagementCycle } = require("../services/smartEngagement.service");

// Secret-protected cron endpoint.
// Send the scheduler credential in the Authorization bearer header.
router.get("/payment-pending-reminders", paymentPendingReminders);

// PATCH_22: Expire rentals that have passed their end date
// Call: GET /api/cron/expire-rentals?secret=...
router.get("/expire-rentals", expireRentalsJob);

// PATCH_53: Process engagement events and send emails
// Call: GET /api/cron/engagement-batch?secret=...
function requireEngagementSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected || !expected.trim()) {
    return res.status(404).json({ message: "Route not found" });
  }
  if (req.query.secret !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

router.get("/engagement-batch", requireEngagementSecret, async (req, res) => {
  try {
    await runEngagementBatch();
    res.json({ success: true, message: "Engagement batch processed" });
  } catch (error) {
    console.error("[Cron] Engagement batch error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH_58: Smart Engagement Engine cycle
// Call: GET /api/cron/smart-engagement?secret=...
router.get("/smart-engagement", requireEngagementSecret, async (req, res) => {
  try {
    const results = await runEngagementCycle();
    res.json({
      success: true,
      message: "Smart engagement cycle completed",
      results,
    });
  } catch (error) {
    console.error("[Cron] Smart engagement error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
