/**
 * PATCH_51: Get Affiliate Status Tool
 * Returns user's affiliate earnings and referral info
 */

const User = require("../../models/User");
const AffiliateCommission = require("../../models/AffiliateCommission");
const { getFrontendUrl } = require("../../config/frontendUrl");

/**
 * Get affiliate status for authenticated user
 * @param {Object} params - {}
 * @param {Object} context - { userId, userRole, isAdmin }
 * @returns {Promise<Object>}
 */
async function getAffiliateStatus(params, context) {
  if (!context.userId) {
    return {
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    };
  }

  try {
    const user = await User.findById(context.userId)
      .select("referralCode affiliateBalance totalAffiliateEarned")
      .lean();

    if (!user) {
      return {
        error: "User not found",
        code: "NOT_FOUND",
      };
    }

    // Get referral count
    const referralCount = await User.countDocuments({
      referredBy: context.userId,
    });

    // Get recent commissions
    const recentCommissions = await AffiliateCommission.find({
      affiliateUserId: context.userId,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    return {
      data: {
        referralCode: user.referralCode,
        referralLink: user.referralCode ? `${getFrontendUrl()}/signup?ref=${encodeURIComponent(user.referralCode)}` : null,
        balance: user.affiliateBalance || 0,
        totalEarned: user.totalAffiliateEarned || 0,
        referralCount,
        recentCommissions: recentCommissions.map((c) => ({
          amount: c.amount,
          status: c.status,
          createdAt: c.createdAt,
        })),
      },
      message: "Affiliate status loaded",
    };
  } catch (err) {
    console.error("[getAffiliateStatus] Error:", err.message);
    return {
      error: "Failed to fetch affiliate status",
      code: "FETCH_ERROR",
    };
  }
}

module.exports = getAffiliateStatus;
