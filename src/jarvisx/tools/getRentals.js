/**
 * PATCH_36: getRentals Tool
 * Retrieves user's active and past rentals
 */

const Rental = require("../../models/Rental");
const { canReadRentalAccess } = require("../../utils/rentalAccess");

/**
 * Get user's rentals
 * @param {Object} params - { status, limit }
 * @param {Object} context - { userId, userRole, isAdmin }
 * @returns {Promise<Object>}
 */
async function getRentals(params, context) {
  const { status, limit = 10 } = params;
  const { userId } = context;

  const query = { user: userId };

  // Filter by status
  if (status && typeof status === "string") {
    const validStatuses = [
      "pending",
      "active",
      "expired",
      "cancelled",
      "renewed",
    ];
    if (validStatuses.includes(status.toLowerCase())) {
      query.status = status.toLowerCase();
    }
  }

  const rentals = await Rental.find(query)
    .select("-accessDetails -notes")
    .populate({ path: "order", match: { userId }, select: "userId rentalId status paymentStatus paidAt payment.verifiedAt" })
    .populate("service", "title price imageUrl")
    .sort({ createdAt: -1 })
    .limit(Math.min(parseInt(limit) || 10, 20))
    .lean();

  if (!rentals || rentals.length === 0) {
    return {
      data: [],
      message: "You don't have any rentals yet. Check out our rental services!",
    };
  }

  const now = new Date();

  const formatted = rentals.map((r) => {
    const isExpired = r.endDate && new Date(r.endDate) < now;
    const daysLeft = r.endDate
      ? Math.max(
          0,
          Math.ceil((new Date(r.endDate) - now) / (1000 * 60 * 60 * 24)),
        )
      : 0;

    return {
      rentalId: r._id,
      service: r.service?.title || "Unknown Service",
      price: r.price,
      status: isExpired ? "expired" : r.status,
      rentalType: r.rentalType,
      duration: r.duration,
      startDate: r.startDate,
      endDate: r.endDate,
      daysRemaining: daysLeft,
      hasAccess: canReadRentalAccess(r, r.order, userId, now),
    };
  });

  // Summary stats
  const active = formatted.filter((r) => r.status === "active").length;
  const expiringSoon = formatted.filter(
    (r) => r.status === "active" && r.daysRemaining <= 7,
  ).length;

  return {
    data: formatted,
    summary: {
      total: rentals.length,
      active,
      expired: formatted.filter((r) => r.status === "expired").length,
      expiringSoon,
    },
    message: `Found ${rentals.length} rentals: ${active} active${
      expiringSoon > 0 ? `, ${expiringSoon} expiring within 7 days` : ""
    }.`,
  };
}

module.exports = getRentals;
