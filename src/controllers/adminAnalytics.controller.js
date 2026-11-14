/**
 * PATCH_30: Admin Analytics Controller
 * Provides dashboard statistics and chart data for admin analytics
 */

const User = require("../models/User");
const Order = require("../models/Order");
const { projectRevenue, legacyRevenue, walletFunding } = require("../services/revenueReporting");
const Ticket = require("../models/Ticket");
const Rental = require("../models/Rental");
const AffiliateCommission = require("../models/AffiliateCommission");
const Service = require("../models/Service");

/**
 * Get admin dashboard analytics
 * GET /api/admin/analytics/dashboard
 */
exports.getAdminAnalytics = async (req, res) => {
  try {
    // Run all queries in parallel for performance
    const [
      totalUsers,
      totalOrders,
      completedOrders,
      processingOrders,
      pendingOrders,
      marketplace,
      legacy,
      funding,
      pendingTickets,
      openTickets,
      activeRentals,
      totalRentals,
      affiliateAgg,
      totalServices,
      newUsersToday,
      ordersToday,
    ] = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      Order.countDocuments({ status: "completed" }),
      Order.countDocuments({ status: "in_progress" }),
      Order.countDocuments({ status: "pending" }),
      projectRevenue(),
      legacyRevenue(),
      walletFunding(),
      Ticket.countDocuments({ status: "open" }),
      Ticket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
      Rental.countDocuments({ status: "active" }),
      Rental.countDocuments(),
      AffiliateCommission.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Service.countDocuments(),
      User.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      Order.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
    ]);

    const legacyByCurrency = legacy.filter(row => row._id !== null)
      .map(row => ({ currency: row._id, total: row.total, count: row.count }));
    const totalRevenue = legacyByCurrency.find(row => row.currency === "USD")?.total || 0;
    const affiliateEarnings = affiliateAgg[0]?.total || 0;

    res.json({
      ok: true,
      stats: {
        // Users
        totalUsers,
        newUsersToday,

        // Orders
        totalOrders,
        completedOrders,
        processingOrders,
        pendingOrders,
        ordersToday,

        // Revenue
        totalRevenue,
        totalWalletVolume: funding.credits,
        marketplace,
        legacyByCurrency,
        legacyUnknown: legacy.find(row => row._id === null)?.count || 0,
        deposits: { currency: "USD", count: funding.depositCount, total: funding.deposits },

        // Support
        pendingTickets,
        openTickets,

        // Rentals
        activeRentals,
        totalRentals,

        // Affiliate
        affiliateEarnings,

        // Services
        totalServices,
      },
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ ok: false, message: "Analytics failed" });
  }
};

/**
 * Get chart data for analytics
 * GET /api/admin/analytics/charts
 */
exports.getCharts = async (req, res) => {
  try {
    const days = Number(req.query.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ ok: false, message: "Choose a period of 1 to 365 days" });
    }
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days + 1);
    startDate.setUTCHours(0, 0, 0, 0);

    const [ordersPerDay, revenuePerDay, usersPerDay, ticketsPerDay] =
      await Promise.all([
        // Orders per day
        Order.aggregate([
          { $match: { createdAt: { $gte: startDate } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        legacyRevenue(startDate),

        // New users per day
        User.aggregate([
          { $match: { createdAt: { $gte: startDate } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        // Tickets per day
        Ticket.aggregate([
          { $match: { createdAt: { $gte: startDate } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
      ]);

    res.json({
      ok: true,
      period: { days, startDate },
      ordersPerDay,
      revenuePerDay,
      usersPerDay,
      ticketsPerDay,
    });
  } catch (err) {
    console.error("Charts error:", err);
    res.status(500).json({ ok: false, message: "Charts failed" });
  }
};

/**
 * Get system health status
 * GET /api/admin/analytics/health
 */
exports.getSystemHealth = async (req, res) => {
  try {
    const mongoose = require("mongoose");

    // Check database connection
    const dbStatus =
      mongoose.connection.readyState === 1 ? "connected" : "disconnected";

    // Get memory usage
    const memUsage = process.memoryUsage();

    // Get uptime
    const uptime = process.uptime();

    // Check recent errors (last hour of failed orders)
    const recentFailedOrders = await Order.countDocuments({
      status: "cancelled",
      updatedAt: { $gte: new Date(Date.now() - 3600000) },
    });

    res.json({
      ok: true,
      health: {
        database: dbStatus,
        uptime: Math.floor(uptime),
        uptimeFormatted: formatUptime(uptime),
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024),
        },
        recentFailedOrders,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({ ok: false, message: "Health check failed" });
  }
};

// Helper function to format uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(" ") || "0m";
}
