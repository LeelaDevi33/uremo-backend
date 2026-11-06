/**
 * PATCH_23: Affiliate Controller
 * Handles affiliate stats, transactions, and withdrawals
 */

const User = require("../models/User");
const AffiliateTransaction = require("../models/AffiliateTransaction");
const AffiliateWithdrawal = require("../models/AffiliateWithdrawal");
const { isWalletAmount } = require("../services/walletFunds");
const { sendNotification } = require("../services/notification.service");

// Global commission rate (10%)
const COMMISSION_RATE = 0.1;
const MINIMUM_WITHDRAWAL = 10;

/**
 * Get user's affiliate stats
 * GET /api/affiliate/stats
 */
exports.getMyAffiliateStats = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    // Get user with affiliate fields
    const user = await User.findById(userId).select(
      "referralCode affiliateBalance totalAffiliateEarned",
    );

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // Count referred users
    const referredUsersCount = await User.countDocuments({
      referredBy: userId,
    });

    // Count transactions
    const transactionStats = await AffiliateTransaction.aggregate([
      { $match: { user: user._id } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          total: { $sum: "$commission" },
        },
      },
    ]);

    // Pending withdrawals
    const pendingWithdrawals = await AffiliateWithdrawal.aggregate([
      { $match: { user: user._id, status: "pending" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const stats = {
      referralCode: user.referralCode,
      affiliateBalance: user.affiliateBalance || 0,
      totalAffiliateEarned: user.totalAffiliateEarned || 0,
      referredUsersCount,
      commissionRate: COMMISSION_RATE * 100, // 10%
      minimumWithdrawal: MINIMUM_WITHDRAWAL,
      pendingWithdrawals: pendingWithdrawals[0]?.total || 0,
      transactionsByStatus: transactionStats.reduce((acc, s) => {
        acc[s._id] = { count: s.count, total: s.total };
        return acc;
      }, {}),
    };

    res.json({ ok: true, stats });
  } catch (err) {
    console.error("getMyAffiliateStats error:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to get affiliate stats" });
  }
};

/**
 * Get user's affiliate transactions
 * GET /api/affiliate/transactions
 */
exports.getMyAffiliateTransactions = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      AffiliateTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("referredUser", "name email")
        .populate("order", "status amount")
        .lean(),
      AffiliateTransaction.countDocuments({ user: userId }),
    ]);

    res.json({
      ok: true,
      transactions,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("getMyAffiliateTransactions error:", err);
    res.status(500).json({ ok: false, message: "Failed to get transactions" });
  }
};

/**
 * Get user's commission history (with order details)
 * GET /api/affiliate/commissions
 */
exports.getMyCommissions = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = req.query.status; // pending, approved, paid

    const filter = { user: userId };
    if (status) filter.status = status;

    const [commissions, total] = await Promise.all([
      AffiliateTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("referredUser", "name email")
        .populate("order", "_id status amount createdAt")
        .lean(),
      AffiliateTransaction.countDocuments(filter),
    ]);

    // Calculate totals from user record
    const user = await User.findById(userId).select(
      "affiliateBalance totalAffiliateEarned",
    );
    if (!user) return res.status(404).json({ ok: false, message: "Referral account not found" });

    // Get total withdrawn
    const withdrawnResult = await AffiliateWithdrawal.aggregate([
      { $match: { user: user._id, status: { $in: ["paid", "pending"] } } },
      { $group: { _id: "$status", total: { $sum: "$amount" } } },
    ]);

    const withdrawnPaid =
      withdrawnResult.find((r) => r._id === "paid")?.total || 0;
    const withdrawnPending =
      withdrawnResult.find((r) => r._id === "pending")?.total || 0;

    res.json({
      ok: true,
      commissions: commissions.map((c) => ({
        _id: c._id,
        referredUserEmail: c.referredUser?.email || "Unknown",
        referredUserName: c.referredUser?.name || "Unknown",
        orderId: c.order?._id || null,
        orderAmount: c.orderAmount,
        commissionAmount: c.commission,
        commissionRate: c.commissionRate,
        status: c.status,
        date: c.createdAt,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
      summary: {
        totalEarnings: user?.totalAffiliateEarned || 0,
        availableBalance: user?.affiliateBalance || 0,
        withdrawnAmount: withdrawnPaid,
        pendingWithdrawal: withdrawnPending,
      },
    });
  } catch (err) {
    console.error("getMyCommissions error:", err);
    res.status(500).json({ ok: false, message: "Failed to get commissions" });
  }
};

/**
 * Request withdrawal
 * POST /api/affiliate/withdraw
 */
exports.withdrawAffiliateBalance = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { amount, paymentMethod, paymentDetails } = req.body;

    const withdrawAmount = typeof amount === "string" ? Number(amount) : amount;
    if (!isWalletAmount(withdrawAmount) || withdrawAmount < MINIMUM_WITHDRAWAL ||
        !["paypal", "crypto", "bank"].includes(paymentMethod) || typeof paymentDetails !== "string" || !paymentDetails.trim()) {
      return res.status(400).json({ ok: false, message: "Provide a supported payout method, payment details and at least $10 in whole cents" });
    }
    const result = await User.db.transaction(async session => {
      if (await AffiliateWithdrawal.exists({ user: userId, status: "pending" }).session(session)) {
        return { message: "You already have a pending withdrawal request" };
      }
      const owner = await User.findOneAndUpdate({ _id: userId, affiliateBalance: { $gte: withdrawAmount } },
        [{ $set: { affiliateBalance: { $toDouble: { $subtract: [
          { $toDecimal: "$affiliateBalance" }, { $toDecimal: withdrawAmount.toFixed(2) },
        ] } } } }], { session, updatePipeline: true });
      if (!owner) return { message: "Insufficient referral balance" };
      const [withdrawal] = await AffiliateWithdrawal.create([{
        user: userId, amount: withdrawAmount, paymentMethod, paymentDetails: paymentDetails.trim(), status: "pending",
      }], { session, ordered: true });
      return { withdrawal };
    });
    if (result.message) return res.status(400).json({ ok: false, message: result.message });
    const { withdrawal } = result;

    res.json({
      ok: true,
      message: "Withdrawal request submitted",
      withdrawal: {
        _id: withdrawal._id,
        amount: withdrawal.amount,
        paymentMethod: withdrawal.paymentMethod,
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
      },
    });
  } catch (err) {
    console.error("withdrawAffiliateBalance error:", err);
    res.status(500).json({ ok: false, message: "Failed to submit withdrawal" });
  }
};

/**
 * Get user's withdrawal history
 * GET /api/affiliate/withdrawals
 */
exports.getMyWithdrawals = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [withdrawals, total] = await Promise.all([
      AffiliateWithdrawal.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AffiliateWithdrawal.countDocuments({ user: userId }),
    ]);

    res.json({
      ok: true,
      withdrawals,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("getMyWithdrawals error:", err);
    res.status(500).json({ ok: false, message: "Failed to get withdrawals" });
  }
};

// ===== ADMIN FUNCTIONS =====

/**
 * Get all affiliates (admin) - The Affiliate Directory
 * GET /api/admin/affiliate/affiliates
 * Lists all users who are affiliates (have earned or have referrals)
 */
exports.getAdminAffiliates = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { status, search, sort = "-totalAffiliateEarned" } = req.query;

    // Build filter for users who are active affiliates
    // An affiliate is someone who has referralCode AND (has referred users OR has earnings)
    const filter = {
      referralCode: { $exists: true, $ne: null, $ne: "" },
    };

    // Status filter
    if (status === "active") {
      filter.$or = [
        { totalAffiliateEarned: { $gt: 0 } },
        { affiliateBalance: { $gt: 0 } },
      ];
    } else if (status === "hasReferrals") {
      // Will filter after aggregation
    }

    // Search filter
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { email: searchRegex },
        { name: searchRegex },
        { referralCode: searchRegex },
      ];
    }

    // Get affiliates with referral counts
    const affiliates = await User.aggregate([
      { $match: filter },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "referredBy",
          as: "referredUsers",
        },
      },
      {
        $lookup: {
          from: "affiliatewithdrawals",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: { $expr: { $eq: ["$user", "$$userId"] }, status: "paid" },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ],
          as: "withdrawalStats",
        },
      },
      {
        $addFields: {
          referralCount: { $size: "$referredUsers" },
          totalWithdrawn: {
            $ifNull: [{ $arrayElemAt: ["$withdrawalStats.total", 0] }, 0],
          },
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          email: 1,
          referralCode: 1,
          affiliateBalance: 1,
          totalAffiliateEarned: 1,
          referralCount: 1,
          totalWithdrawn: 1,
          createdAt: 1,
          isActive: {
            $or: [
              { $gt: ["$totalAffiliateEarned", 0] },
              { $gt: ["$referralCount", 0] },
            ],
          },
        },
      },
      // Filter by status after aggregation
      ...(status === "hasReferrals"
        ? [{ $match: { referralCount: { $gt: 0 } } }]
        : []),
      ...(status === "active" ? [{ $match: { isActive: true } }] : []),
      // Sort
      {
        $sort:
          sort === "referralCount"
            ? { referralCount: -1 }
            : sort === "-referralCount"
              ? { referralCount: -1 }
              : sort === "affiliateBalance"
                ? { affiliateBalance: -1 }
                : sort === "totalAffiliateEarned"
                  ? { totalAffiliateEarned: -1 }
                  : sort === "-createdAt"
                    ? { createdAt: -1 }
                    : { totalAffiliateEarned: -1 },
      },
      { $skip: skip },
      { $limit: limit },
    ]);

    // Get total count
    const totalCountPipeline = [
      { $match: filter },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "referredBy",
          as: "referredUsers",
        },
      },
      {
        $addFields: {
          referralCount: { $size: "$referredUsers" },
          isActive: {
            $or: [
              { $gt: ["$totalAffiliateEarned", 0] },
              { $gt: ["$affiliateBalance", 0] },
            ],
          },
        },
      },
      ...(status === "hasReferrals"
        ? [{ $match: { referralCount: { $gt: 0 } } }]
        : []),
      ...(status === "active" ? [{ $match: { isActive: true } }] : []),
      { $count: "total" },
    ];

    const countResult = await User.aggregate(totalCountPipeline);
    const total = countResult[0]?.total || 0;

    // Get summary stats
    const statsResult = await User.aggregate([
      { $match: { referralCode: { $exists: true, $ne: null, $ne: "" } } },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "referredBy",
          as: "referredUsers",
        },
      },
      {
        $group: {
          _id: null,
          totalAffiliates: { $sum: 1 },
          totalEarned: { $sum: "$totalAffiliateEarned" },
          totalBalance: { $sum: "$affiliateBalance" },
          totalReferrals: { $sum: { $size: "$referredUsers" } },
          activeAffiliates: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $gt: ["$totalAffiliateEarned", 0] },
                    { $gt: [{ $size: "$referredUsers" }, 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    const stats = statsResult[0] || {
      totalAffiliates: 0,
      totalEarned: 0,
      totalBalance: 0,
      totalReferrals: 0,
      activeAffiliates: 0,
    };

    res.json({
      ok: true,
      affiliates,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats,
    });
  } catch (err) {
    console.error("getAdminAffiliates error:", err);
    res.status(500).json({ ok: false, message: "Failed to get affiliates" });
  }
};

/**
 * Get single affiliate details (admin)
 * GET /api/admin/affiliate/affiliates/:id
 */
exports.getAdminAffiliateById = async (req, res) => {
  try {
    const { id } = req.params;

    // Get affiliate user
    const user = await User.findById(id).select(
      "name email referralCode affiliateBalance totalAffiliateEarned createdAt",
    );

    if (!user) {
      return res
        .status(404)
        .json({ ok: false, message: "Affiliate not found" });
    }

    // Get referred users
    const referredUsers = await User.find({ referredBy: id })
      .select("name email createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // Get commission history
    const commissions = await AffiliateTransaction.find({ user: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("referredUser", "name email")
      .populate("order", "_id status amount")
      .lean();

    // Get withdrawal history
    const withdrawals = await AffiliateWithdrawal.find({ user: id })
      .sort({ createdAt: -1 })
      .populate("processedBy", "name email")
      .lean();

    // Calculate stats
    const totalWithdrawn = withdrawals
      .filter((w) => w.status === "paid")
      .reduce((sum, w) => sum + w.amount, 0);

    const pendingWithdrawals = withdrawals
      .filter((w) => w.status === "pending")
      .reduce((sum, w) => sum + w.amount, 0);

    const successfulReferrals = commissions.filter(
      (c) => c.status === "approved",
    ).length;

    res.json({
      ok: true,
      affiliate: {
        _id: user._id,
        name: user.name,
        email: user.email,
        referralCode: user.referralCode,
        referralLink: `https://uremo.world/signup?ref=${user.referralCode}`,
        commissionRate: 10, // 10%
        affiliateBalance: user.affiliateBalance || 0,
        totalAffiliateEarned: user.totalAffiliateEarned || 0,
        totalWithdrawn,
        pendingWithdrawals,
        totalReferrals: referredUsers.length,
        successfulReferrals,
        createdAt: user.createdAt,
      },
      referredUsers,
      commissions: commissions.map((c) => ({
        _id: c._id,
        referredUserEmail: c.referredUser?.email || "Unknown",
        referredUserName: c.referredUser?.name || "Unknown",
        orderId: c.order?._id,
        orderAmount: c.orderAmount,
        commissionAmount: c.commission,
        status: c.status,
        date: c.createdAt,
      })),
      withdrawals,
    });
  } catch (err) {
    console.error("getAdminAffiliateById error:", err);
    res.status(500).json({ ok: false, message: "Failed to get affiliate" });
  }
};

/**
 * Get all withdrawal requests (admin)
 * GET /api/admin/affiliate/withdrawals
 */
exports.getAdminWithdrawals = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = req.query.status || "";

    const filter = {};
    if (status) filter.status = status;

    const [withdrawals, total] = await Promise.all([
      AffiliateWithdrawal.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email referralCode")
        .populate("processedBy", "name email")
        .lean(),
      AffiliateWithdrawal.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      withdrawals,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("getAdminWithdrawals error:", err);
    res.status(500).json({ ok: false, message: "Failed to get withdrawals" });
  }
};

/**
 * Approve withdrawal (admin)
 * PUT /api/admin/affiliate/withdrawals/:id/approve
 * PATCH-64: Enhanced with guardrails and audit logging
 */
async function finishHistoricalWithdrawal(id, status, actor, notes, transactionId) {
  return AffiliateWithdrawal.db.transaction(async session => {
    const withdrawal = await AffiliateWithdrawal.findById(id).session(session);
    if (!withdrawal) return { status: 404, error: "Withdrawal not found" };
    if (withdrawal.status !== "pending") return { status: 400, error: "Withdrawal already processed" };
    if (!await User.exists({ _id: withdrawal.user }).session(session)) return { status: 404, error: "Referral account not found" };
    if (status === "rejected") {
      await User.updateOne({ _id: withdrawal.user }, [{ $set: { affiliateBalance: { $toDouble: { $add: [
        { $toDecimal: { $ifNull: ["$affiliateBalance", 0] } }, { $toDecimal: String(withdrawal.amount) },
      ] } } } }], { session, updatePipeline: true });
    } else {
      withdrawal.transactionId = transactionId || "";
    }
    withdrawal.set({ status, adminNotes: notes || "", processedBy: actor, processedAt: new Date() });
    await withdrawal.save({ session });
    return { withdrawal };
  });
}

exports.approveWithdrawal = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");
    const { id } = req.params;
    const { transactionId, adminNotes } = req.body;

    const result = await finishHistoricalWithdrawal(id, "paid", req.user.id || req.user._id, adminNotes, transactionId);
    if (result.error) return res.status(result.status).json({ ok: false, message: result.error });
    const { withdrawal } = result;
    const previousStatus = "pending";

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: "affiliate_withdrawal_approve",
      entityType: "affiliate_withdrawal",
      entityId: String(id),
      previousState: { status: previousStatus },
      newState: { status: "paid", transactionId },
      reason: adminNotes || "Withdrawal approved by admin",
      metadata: {
        userId: String(withdrawal.user),
        amount: withdrawal.amount,
        paymentMethod: withdrawal.paymentMethod,
      },
    });

    // PATCH_29: Notify user about approved withdrawal
    try {
      await sendNotification({
        userId: withdrawal.user,
        title: "Withdrawal Approved",
        message: `Your withdrawal of $${withdrawal.amount.toFixed(2)} has been approved and paid!`,
        type: "affiliate",
        resourceType: "withdrawal",
        resourceId: withdrawal._id,
      });
    } catch (notifErr) {
      console.error(
        "[notification] withdrawal approved failed:",
        notifErr.message,
      );
    }

    res.json({
      ok: true,
      message: "Withdrawal approved and marked as paid",
      withdrawal,
    });
  } catch (err) {
    console.error("approveWithdrawal error:", err);
    res
      .status(500)
      .json({ ok: false, message: "Failed to approve withdrawal" });
  }
};

/**
 * Reject withdrawal (admin)
 * PUT /api/admin/affiliate/withdrawals/:id/reject
 */
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNotes } = req.body;

    const result = await finishHistoricalWithdrawal(id, "rejected", req.user.id || req.user._id, adminNotes);
    if (result.error) return res.status(result.status).json({ ok: false, message: result.error });
    const { withdrawal } = result;

    // PATCH_29: Notify user about rejected withdrawal
    try {
      await sendNotification({
        userId: withdrawal.user,
        title: "Withdrawal Rejected",
        message: `Your withdrawal request of $${withdrawal.amount.toFixed(2)} was rejected. The balance has been refunded to your account.`,
        type: "affiliate",
        resourceType: "withdrawal",
        resourceId: withdrawal._id,
      });
    } catch (notifErr) {
      console.error(
        "[notification] withdrawal rejected failed:",
        notifErr.message,
      );
    }

    res.json({
      ok: true,
      message: "Withdrawal rejected and balance refunded",
      withdrawal,
    });
  } catch (err) {
    console.error("rejectWithdrawal error:", err);
    res.status(500).json({ ok: false, message: "Failed to reject withdrawal" });
  }
};

/**
 * Get all affiliate transactions (admin)
 * GET /api/admin/affiliate/transactions
 */
exports.getAdminTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      AffiliateTransaction.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email referralCode")
        .populate("referredUser", "name email")
        .populate("order", "status amount")
        .lean(),
      AffiliateTransaction.countDocuments(),
    ]);

    // Get summary stats
    const stats = await AffiliateTransaction.aggregate([
      {
        $group: {
          _id: null,
          totalCommissions: { $sum: "$commission" },
          totalOrders: { $sum: "$orderAmount" },
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({
      ok: true,
      transactions,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: stats[0] || { totalCommissions: 0, totalOrders: 0, count: 0 },
    });
  } catch (err) {
    console.error("getAdminTransactions error:", err);
    res.status(500).json({ ok: false, message: "Failed to get transactions" });
  }
};

/**
 * Process affiliate commission for a paid order
 * Called internally when order is marked as paid
 */
exports.processOrderCommission = async (order, buyerId) => {
  try {
    // Get buyer
    const buyer = await User.findById(buyerId);
    if (!buyer || !buyer.referredBy) {
      return null; // No referrer, no commission
    }

    // Get referrer
    const referrer = await User.findById(buyer.referredBy);
    if (!referrer) {
      return null;
    }

    // Calculate commission
    const orderAmount = order.amount || order.price || 0;
    const commission = orderAmount * COMMISSION_RATE;

    if (commission <= 0) {
      return null;
    }

    // Create transaction
    const transaction = await AffiliateTransaction.create({
      user: referrer._id,
      referredUser: buyer._id,
      order: order._id,
      orderAmount,
      commissionRate: COMMISSION_RATE,
      commission,
      status: "approved",
    });

    // Update referrer balance
    referrer.affiliateBalance = (referrer.affiliateBalance || 0) + commission;
    referrer.totalAffiliateEarned =
      (referrer.totalAffiliateEarned || 0) + commission;
    await referrer.save();

    console.log(
      `[AFFILIATE] Commission $${commission.toFixed(2)} credited to ${referrer.email} for order ${order._id}`,
    );

    return transaction;
  } catch (err) {
    console.error("[AFFILIATE] processOrderCommission error:", err);
    return null;
  }
};

// Export commission rate for other modules
exports.COMMISSION_RATE = COMMISSION_RATE;
exports.MINIMUM_WITHDRAWAL = MINIMUM_WITHDRAWAL;
