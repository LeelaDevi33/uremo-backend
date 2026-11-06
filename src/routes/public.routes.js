/**
 * PATCH_41: Public Routes
 * Non-authenticated public data endpoints
 */

const express = require("express");
const router = express.Router();

/**
 * GET /api/public/trust
 * Returns trust signals for display on homepage
 * Non-numeric, evergreen content only
 */
router.get("/trust", (_req, res) => {
  res.json({ ok: true, trustSignals: [
    { id: "free_application", title: "Free applications", description: "Apply directly for a published role." },
    { id: "rental_term", title: "Fixed rental term", description: "See the price and access duration before confirming." },
    { id: "exclusive_sale", title: "Exclusive purchase", description: "An outright purchase closes the listing." },
  ] });
});

router.get("/categories", async (_req, res, next) => {
  try {
    const Opportunity = require("../models/Opportunity");
    const names = await Opportunity.distinct("category", { status: "published", soldAt: null });
    res.json({ ok: true, categories: names.filter(Boolean).map(name => ({ id: name, name })) });
  } catch (err) {
    next(err);
  }
});

router.get("/stats", async (req, res) => {
  try {
    const Opportunity = require("../models/Opportunity");
    const WorkPosition = require("../models/WorkPosition");
    const User = require("../models/User");
    const Order = require("../models/Order");

    // Get real counts from database
    const [activeServices, activeJobRoles, totalUsers, completedOrders] =
      await Promise.all([
        Opportunity.countDocuments({ status: "published", soldAt: null }),
        WorkPosition.countDocuments({ active: true }),
        User.countDocuments({ role: { $ne: "admin" } }),
        Order.countDocuments({ status: "completed" }),
      ]);

    res.json({
      ok: true,
      stats: {
        activeOpportunities: activeServices,
        activeServices,
        activeJobRoles,
        totalUsers,
        completedOrders,
      },
    });
  } catch (err) {
    console.error("Public stats error:", err);
    res.status(503).json({ ok: false, message: "Platform stats unavailable" });
  }
});

module.exports = router;
