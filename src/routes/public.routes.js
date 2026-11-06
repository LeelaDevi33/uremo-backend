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
router.get("/trust", (req, res) => {
  res.json({
    ok: true,
    trustSignals: [
      {
        id: "manual_verification",
        icon: "🔍",
        title: "Manual Verification",
        description: "Human-reviewed since 2024",
      },
      {
        id: "accounts_processed",
        icon: "✅",
        title: "Accounts Processed",
        description: "Hundreds of successful verifications",
      },
      {
        id: "fulfillment_time",
        icon: "⚡",
        title: "Fast Fulfillment",
        description: "24-48 hour average completion",
      },
      {
        id: "human_support",
        icon: "💬",
        title: "Human Support",
        description: "Real people, real assistance",
      },
    ],
  });
});

/**
 * GET /api/public/categories
 * Returns available service categories
 * PATCH_62: Aligned with actual service.category values in database
 */
router.get("/categories", (req, res) => {
  res.json({
    ok: true,
    categories: [
      {
        id: "microjobs",
        name: "Microjobs & Gigs",
        icon: "💼",
        description: "AI training, data entry, and freelance work",
      },
      {
        id: "forex_crypto",
        name: "Forex & Crypto",
        icon: "📈",
        description: "Trading accounts and exchange verification",
      },
      {
        id: "banks_gateways_wallets",
        name: "Banks & Wallets",
        icon: "🏦",
        description: "Bank accounts, payment gateways, and e-wallets",
      },
      {
        id: "rentals",
        name: "Account Rentals",
        icon: "🔑",
        description: "Rent verified accounts on flexible plans",
      },
      {
        id: "general",
        name: "General Services",
        icon: "🛠️",
        description: "Other digital services and support",
      },
    ],
  });
});

/**
 * PATCH_50: GET /api/public/stats
 * Returns real platform stats for homepage display
 */
router.get("/stats", async (req, res) => {
  try {
    const Service = require("../models/Service");
    const WorkPosition = require("../models/WorkPosition");
    const User = require("../models/User");
    const Order = require("../models/Order");

    // Get real counts from database
    const [activeServices, activeJobRoles, totalUsers, completedOrders] =
      await Promise.all([
        Service.countDocuments({ active: true }),
        WorkPosition.countDocuments({ active: true }),
        User.countDocuments({ role: { $ne: "admin" } }),
        Order.countDocuments({ status: "completed" }),
      ]);

    res.json({
      ok: true,
      stats: {
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
