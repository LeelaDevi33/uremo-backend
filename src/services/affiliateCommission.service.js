/**
 * Affiliate Commission Service
 * Handles automatic commission processing when orders are paid
 */

const User = require("../models/User");
const Order = require("../models/Order");
const AffiliateCommission = require("../models/AffiliateCommission");
const { sendNotification } = require("./notification.service");

const COMMISSION_PERCENT = 10; // 10% commission rate

/**
 * Process affiliate commission for a paid order
 * Called when order is marked as paid (via wallet or admin verification)
 *
 * @param {string} orderId - The order ID to process commission for
 * @param {string} paymentMethod - How the order was paid (wallet, stripe, manual)
 * @returns {Object|null} - The created commission record or null
 */
exports.processAffiliateCommission = async (
  orderId,
  paymentMethod = "other",
) => {
  try {
    // Get order with service details for price
    const order = await Order.findById(orderId).populate("serviceId", "price");

    if (!order) {
      console.log(`[AffiliateCommission] Order not found: ${orderId}`);
      return null;
    }

    // Prevent duplicate commission for the same order
    const existingCommission = await AffiliateCommission.findOne({
      order: orderId,
    });
    if (existingCommission) {
      console.log(
        `[AffiliateCommission] Commission already exists for order: ${orderId}`,
      );
      return existingCommission;
    }

    // Get the buyer (the user who placed the order)
    const buyer = await User.findById(order.userId);
    if (!buyer) {
      console.log(
        `[AffiliateCommission] Buyer not found for order: ${orderId}`,
      );
      return null;
    }

    // Check if buyer was referred by someone
    if (!buyer.referredBy) {
      console.log(
        `[AffiliateCommission] Buyer has no referrer: ${buyer.email}`,
      );
      return null;
    }

    // Get the referrer
    const referrer = await User.findById(buyer.referredBy);
    if (!referrer) {
      console.log(
        `[AffiliateCommission] Referrer not found: ${buyer.referredBy}`,
      );
      return null;
    }

    // Calculate order amount from service price
    if (order.settledCurrency && order.settledCurrency !== "USD") return null;
    const orderAmount = order.settledAmount ?? order.quotedAmount ?? order.serviceId?.price ?? 0;
    if (orderAmount <= 0) {
      console.log(`[AffiliateCommission] Invalid order amount: ${orderAmount}`);
      return null;
    }

    // Calculate commission (10% of order amount)
    const commissionAmount = (orderAmount * COMMISSION_PERCENT) / 100;

    // Create the commission record
    const commission = await AffiliateCommission.create({
      referrer: referrer._id,
      referredUser: buyer._id,
      order: order._id,
      orderAmount: orderAmount,
      amount: commissionAmount,
      commissionRate: COMMISSION_PERCENT,
      status: "pending", // Commission starts as pending
      paymentMethod: paymentMethod,
    });

    // Add commission to referrer's affiliate balance
    referrer.affiliateBalance =
      (referrer.affiliateBalance || 0) + commissionAmount;
    referrer.totalAffiliateEarned =
      (referrer.totalAffiliateEarned || 0) + commissionAmount;
    await referrer.save();

    console.log(
      `[AffiliateCommission] Created: $${commissionAmount.toFixed(2)} for referrer ${referrer.email} ` +
        `(order: ${orderId}, buyer: ${buyer.email})`,
    );

    // PATCH_29: Notify referrer about earned commission
    try {
      await sendNotification({
        userId: referrer._id,
        title: "Commission Earned",
        message: `You earned $${commissionAmount.toFixed(2)} commission from a referral purchase!`,
        type: "affiliate",
        sendEmailCopy: true,
      });
    } catch (notifErr) {
      console.error("[notification] commission earned failed:", notifErr.message);
    }

    return commission;
  } catch (error) {
    console.error("[AffiliateCommission] Error processing commission:", error);
    return null;
  }
};

/**
 * Get commission statistics for a referrer
 */
exports.getReferrerStats = async (referrerId) => {
  try {
    const commissions = await AffiliateCommission.find({ referrer: referrerId })
      .populate("referredUser", "name email")
      .populate("order", "status createdAt")
      .sort({ createdAt: -1 });

    const totalEarned = commissions.reduce((sum, c) => sum + c.amount, 0);
    const pendingAmount = commissions
      .filter((c) => c.status === "pending")
      .reduce((sum, c) => sum + c.amount, 0);
    const paidAmount = commissions
      .filter((c) => c.status === "paid")
      .reduce((sum, c) => sum + c.amount, 0);

    return {
      commissions,
      totalEarned,
      pendingAmount,
      paidAmount,
      count: commissions.length,
    };
  } catch (error) {
    console.error("[AffiliateCommission] Error getting stats:", error);
    return {
      commissions: [],
      totalEarned: 0,
      pendingAmount: 0,
      paidAmount: 0,
      count: 0,
    };
  }
};

/**
 * Approve a pending commission (admin action)
 */
exports.approveCommission = async (commissionId) => {
  try {
    const commission = await AffiliateCommission.findByIdAndUpdate(
      commissionId,
      { status: "approved" },
      { new: true },
    );
    return commission;
  } catch (error) {
    console.error("[AffiliateCommission] Error approving:", error);
    return null;
  }
};

/**
 * Mark commission as paid (admin action)
 */
exports.markCommissionPaid = async (commissionId) => {
  try {
    const commission = await AffiliateCommission.findByIdAndUpdate(
      commissionId,
      { status: "paid", paidAt: new Date() },
      { new: true },
    );
    return commission;
  } catch (error) {
    console.error("[AffiliateCommission] Error marking paid:", error);
    return null;
  }
};
