/**
 * PATCH_23: Wallet Controller
 * PATCH_80: Payment Gateway Foundation - No instant credits, verification required
 *
 * KEY PRINCIPLES:
 * - Wallet balance ONLY changes when topup status === 'success'
 * - All topups start as 'initiated', require verification to complete
 * - Internal operations (service purchase, admin adjust) are instant
 */
const User = require("../models/User");
const WalletTransaction = require("../models/WalletTransaction");
const { paymentReference } = require("../services/walletFunding");
const Order = require("../models/Order");
const Rental = require("../models/Rental");
const { availableFunds, changeFunds, isWalletAmount } = require("../services/walletFunds");
const { sendNotification } = require("../services/notification.service");

// PATCH_31: FlowEngine for orchestrated state transitions
const FlowEngine = require("../core/flowEngine");

/**
 * Get current wallet balance
 * GET /api/wallet/balance
 */
exports.getBalance = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const user = await User.findById(userId).select(
      "walletBalance withdrawable pendingWithdrawals lifetimeEarnings lastWalletUpdate",
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // PATCH_80: Also return pending topups count
    // PATCH_82: Include paid_unverified for PayPal payments awaiting admin verification
    const pendingCount = await WalletTransaction.countDocuments({
      user: userId,
      source: "topup",
      status: { $in: ["initiated", "pending", "paid_unverified"] },
    });

    res.json({
      success: true,
      balance: user.walletBalance || 0,
      ...availableFunds(user),
      pendingWithdrawals: user.pendingWithdrawals || 0,
      lifetimeEarnings: user.lifetimeEarnings || 0,
      lastWalletUpdate: user.lastWalletUpdate,
      pendingTopups: pendingCount,
    });
  } catch (err) {
    console.error("getBalance error:", err);
    res.status(500).json({ error: "Failed to get balance" });
  }
};

/**
 * PATCH_80: Get user's pending topup requests
 * PATCH_82: Added paid_unverified status for PayPal payments
 * GET /api/wallet/pending
 */
exports.getPendingTopups = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    const pendingTopups = await WalletTransaction.find({
      user: userId,
      source: "topup",
      status: { $in: ["initiated", "pending", "paid_unverified"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      pendingTopups,
    });
  } catch (err) {
    console.error("getPendingTopups error:", err);
    res.status(500).json({ error: "Failed to get pending topups" });
  }
};

/**
 * PATCH_80: Cancel a pending topup request
 * PATCH_81: Made atomic to prevent race conditions
 * POST /api/wallet/cancel-topup
 * Body: { transactionId }
 */
exports.cancelTopup = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.id || req.user._id;

    if (!transactionId) {
      return res.status(400).json({ error: "Transaction ID required" });
    }

    // PATCH_81: ATOMIC update - only cancel if status is still 'initiated'
    const updatedTransaction = await WalletTransaction.findOneAndUpdate(
      {
        _id: transactionId,
        user: userId,
        source: "topup",
        provider: { $in: ["manual", "internal", null] },
        status: "initiated", // Only can cancel 'initiated', not 'pending' (in progress)
      },
      {
        $set: {
          status: "failed",
          failureReason: "Cancelled by user",
        },
      },
      { new: true },
    );

    if (!updatedTransaction) {
      // Check if it exists but was already processed
      const existingTx = await WalletTransaction.findOne({
        _id: transactionId,
        user: userId,
      });
      if (!existingTx) {
        return res.status(404).json({ error: "Transaction not found" });
      }
      if (existingTx.provider === "paypal") return res.status(409).json({ error: "PayPal manages this payment." });
      if (existingTx.status === "pending") {
        return res.status(400).json({
          error: "Cannot cancel - payment is being processed",
        });
      }
      if (existingTx.status === "success") {
        return res.status(400).json({
          error: "Cannot cancel - already completed",
        });
      }
      if (existingTx.status === "failed") {
        return res.status(400).json({
          error: "Already cancelled or failed",
        });
      }
      return res.status(404).json({
        error: "Transaction not found or cannot be cancelled",
      });
    }

    res.json({
      success: true,
      message: "Top-up request cancelled",
    });
  } catch (err) {
    console.error("cancelTopup error:", err);
    res.status(500).json({ error: "Failed to cancel top-up" });
  }
};

/**
 * Get transaction history
 * GET /api/wallet/transactions
 * Query: { page, limit }
 */
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ user: userId }),
    ]);

    // PATCH_39: Always return fresh wallet balance
    const freshUser = await User.findById(userId).select("walletBalance");
    res.json({
      success: true,
      balance: freshUser?.walletBalance || 0,
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("getTransactions error:", err);
    res.status(500).json({ error: "Failed to get transactions" });
  }
};

/**
 * Pay for order using wallet
 * POST /api/wallet/pay
 * Body: { orderId }
 */
exports.payWithWallet = async (req, res) => {
  const { orderId, expectedAmount, expectedCurrency } = req.body;
  if (!orderId || !Order.base.isObjectIdOrHexString(orderId)) {
    return res.status(400).json({ error: "A valid order ID is required" });
  }
  const userId = req.user.id || req.user._id;

  try {
    const result = await Order.db.transaction(async (session) => {
      const order = await Order.findById(orderId)
        .session(session)
        .populate("serviceId", "price currency");
      if (!order) return { status: 404, error: "Order not found" };
      if (String(order.userId) !== String(userId)) {
        return { status: 403, error: "Not authorized" };
      }
      if (order.status !== "pending" || order.paidAt || ["paid", "refunded"].includes(order.paymentStatus)) {
        return { status: 400, error: "Order already paid or closed" };
      }
      if (order.expiresAt && order.expiresAt <= new Date()) {
        return { status: 410, error: "Order expired. Reserve the service again." };
      }

      let amount = order.quotedAmount;
      let currency = order.quotedCurrency;
      let isRental = order.orderType === "rental";
      if (amount == null) {
        // Legacy renewals can lack both orderType and rentalId. The rental still
        // points at its order and holds the price of the selected plan.
        const rental = await Rental.findOne({ order: order._id })
          .select("price currency")
          .session(session)
          .lean();
        isRental = isRental || Boolean(rental);
        const offer = isRental ? rental : order.serviceId;
        amount = offer?.price;
        currency = offer?.currency;
      }
      currency = String(currency || "USD").trim().toUpperCase();
      if (!Number.isFinite(amount) || amount < 0.01) {
        return { status: 400, error: "Unable to determine order price" };
      }
      if (currency !== "USD") {
        return { status: 400, error: "Wallet payments require a USD quote" };
      }
      if ((expectedAmount !== undefined && expectedAmount !== amount) ||
          (expectedCurrency !== undefined && expectedCurrency !== currency)) {
        return { status: 409, error: "The order price has changed. Refresh before paying." };
      }

      const user = await changeFunds(userId, amount, "spend", session);

      await WalletTransaction.create([{
        user: userId,
        type: "debit",
        amount,
        source: isRental ? "rental_purchase" : "service_purchase",
        status: "success",
        provider: "internal",
        referenceId: order._id,
        description: `Payment for order #${order._id.toString().slice(-6)}`,
        balanceBefore: user.balanceBefore,
        balanceAfter: user.walletBalance,
      }], { session, ordered: true });

      order.settledAmount = amount;
      order.settledCurrency = currency;
      const event = await FlowEngine.saveTransition("order", order, "in_progress", {
        actor: "system",
        reason: "Payment completed via wallet",
        paymentMethod: "wallet",
        data: { walletBalance: user.walletBalance },
      });
      return { event, walletBalance: user.walletBalance };
    });

    if (result.error) {
      const { status, ...body } = result;
      return res.status(status).json(body);
    }
    const order = result.event.item;
    order.$session(null);
    FlowEngine.publishTransition("order", result.event);
    return res.json({
      success: true,
      message: "Payment successful",
      order: { _id: order._id, paymentStatus: order.paymentStatus, status: order.status },
      walletBalance: result.walletBalance,
    });
  } catch (err) {
    if (err.status) return res.status(err.status === 402 ? 400 : err.status).json({ error: err.message, ...err.fields });
    console.error("payWithWallet error:", err);
    return res.status(500).json({ error: "Payment failed" });
  }
};

// ============================================
// ADMIN FUNCTIONS
// ============================================

const adjustments = require("../services/walletAdjustments");

async function respondToAdjustment(req, res, undo) {
  try {
    const { receipt, replayed } = undo ? await adjustments.undo(req.user, req.params.id) : await adjustments.adjust(req.user, req.body);
    const action = receipt.type === "credit" ? "credited" : "debited";
    if (!replayed) {
      await sendNotification({
        userId: receipt.user, title: "Wallet Update", type: "wallet",
        message: `Your wallet was ${action} $${receipt.amount.toFixed(2)}. Balance after adjustment: $${receipt.balanceAfter.toFixed(2)}`,
      }).catch(err => console.warn("[notification] wallet adjustment failed:", err.name));
    }
    const user = await User.findById(receipt.user).select("name email walletBalance").lean();
    res.json({ success: true, transactionId: receipt._id, replayed, user,
      message: undo ? "Adjustment reversed." : `Wallet ${action} $${receipt.amount.toFixed(2)}.` });
  } catch (err) {
    if (err.status) return res.status(err.status === 402 ? 400 : err.status).json({ error: err.message, ...err.fields });
    console.error("Wallet adjustment failed", { name: err.name, code: err.code });
    res.status(500).json({ error: "Failed to adjust balance. Retry with the same request." });
  }
}

exports.adminAdjustBalance = (req, res) => respondToAdjustment(req, res, false);
exports.adminUndoAdjustment = (req, res) => respondToAdjustment(req, res, true);

/**
 * PATCH_80: Admin - Get all pending topup requests
 * GET /api/admin/wallet/pending-topups
 * Returns list of all transactions with status='initiated' or 'pending'
 */
exports.adminGetPendingTopups = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [pendingTopups, total] = await Promise.all([
      WalletTransaction.find({
        source: "topup",
        provider: { $in: ["manual", "internal", null] },
        status: { $in: ["initiated", "pending", "paid_unverified"] },
      })
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({
        source: "topup",
        provider: { $in: ["manual", "internal", null] },
        status: { $in: ["initiated", "pending", "paid_unverified"] },
      }),
    ]);

    res.json({
      success: true,
      pendingTopups,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("adminGetPendingTopups error:", err);
    res.status(500).json({ error: "Failed to get pending topups" });
  }
};

/**
 * PATCH_80: Admin - Verify a topup request
 * PATCH_81: Added ATOMIC race condition protection
 * POST /api/admin/wallet/verify-topup
 * Body: { transactionId, action: 'approve' | 'reject', reason? }
 *
 * THIS IS THE ONLY WAY TO CREDIT WALLET FOR TOPUPS
 *
 * SAFETY GUARANTEES (PATCH_81):
 *   - Atomic status update prevents double-credit
 *   - findOneAndUpdate with status condition = idempotent
 *   - Balance only changes if status transition succeeds
 *   - Second request gets "already processed" error
 */
exports.adminVerifyTopup = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");
    const { transactionId, action, reason } = req.body;

    if (!transactionId || !action) {
      return res
        .status(400)
        .json({ error: "transactionId and action required" });
    }

    if (!["approve", "reject", "pending"].includes(action)) {
      return res
        .status(400)
        .json({ error: "Action must be approve, reject, or pending" });
    }

    const { updatedTransaction, previousStatus, user, updatedUser } = await User.db.transaction(async session => {
      const transaction = await WalletTransaction.findById(transactionId).session(session);
      const fail = (status, message, fields) => { throw Object.assign(new Error(message), { status, fields }); };
      if (!transaction) fail(404, "Transaction not found");
      if (transaction.provider != null && !["manual", "internal"].includes(transaction.provider)) fail(409, "Gateway payments require confirmation from the provider.");
      if (transaction.source !== "topup") fail(400, "Only topup transactions can be verified");
      if (!["initiated", "pending", "paid_unverified"].includes(transaction.status)) {
        fail(400, "Transaction already processed", { alreadyProcessed: true });
      }
      const user = await User.findById(transaction.user).select("name email").session(session).lean();
      if (!user) fail(404, "User not found");
      const previousStatus = transaction.status;
      let updatedUser;
      if (action === "approve") {
        const reference = paymentReference(req.body.settlementReference);
        if (!reference) {
          fail(400, "Enter the unique reference from the verified payment record (4–80 letters, digits, dots, slashes, underscores or hyphens).");
        }
        if (transaction.paymentReference && transaction.paymentReference !== reference) fail(400, "The verified payment reference must match the submitted transfer.");
        transaction.set({ settlementReference: reference, settlementVerifiedBy: req.user.id });
        updatedUser = await changeFunds(user._id, transaction.amount, "credit", session);
        transaction.set({ status: "success", description: "Wallet top-up (verified)",
          balanceBefore: updatedUser.balanceBefore, balanceAfter: updatedUser.walletBalance });
      } else if (action === "reject") {
        transaction.set({ status: "failed", failureReason: reason || "Rejected by admin" });
      } else {
        transaction.status = "pending";
      }
      await transaction.save({ session });
      return { updatedTransaction: transaction, previousStatus, user, updatedUser };
    });
    if (action === "approve") {

      // Log admin action
      await logAdminAction({
        adminId: req.user?._id || req.user?.id,
        adminEmail: req.user?.email,
        action: "topup_approve",
        entityType: "wallet_transaction",
        entityId: String(transactionId),
        previousState: { status: previousStatus },
        newState: {
          status: "success",
          balanceAfter: updatedUser.walletBalance,
        },
        reason: reason || "Topup verified and approved",
        metadata: {
          amount: updatedTransaction.amount,
          userId: String(user._id),
        },
      });

      // Notify user
      try {
        await sendNotification({
          userId: user._id,
          title: "Wallet Top-up Confirmed",
          message: `Your top-up of $${updatedTransaction.amount.toFixed(2)} has been verified. New balance: $${updatedUser.walletBalance.toFixed(2)}`,
          type: "wallet",
        });
      } catch (notifErr) {
        console.error(
          "[notification] topup approval failed:",
          notifErr.message,
        );
      }

      res.json({
        success: true,
        message: `Approved $${updatedTransaction.amount.toFixed(2)} topup for ${user.email}`,
        transaction: {
          _id: updatedTransaction._id,
          status: "success",
          amount: updatedTransaction.amount,
          balanceAfter: updatedUser.walletBalance,
        },
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          walletBalance: updatedUser.walletBalance,
        },
      });
    } else if (action === "reject") {
      // Log admin action
      await logAdminAction({
        adminId: req.user?._id || req.user?.id,
        adminEmail: req.user?.email,
        action: "topup_reject",
        entityType: "wallet_transaction",
        entityId: String(transactionId),
        previousState: { status: previousStatus },
        newState: { status: "failed" },
        reason: reason || "Topup rejected",
        metadata: {
          amount: updatedTransaction.amount,
          userId: String(user._id),
        },
      });

      // Notify user
      try {
        await sendNotification({
          userId: user._id,
          title: "Wallet Top-up Failed",
          message: `Your top-up request of $${updatedTransaction.amount.toFixed(2)} could not be processed. ${reason ? `Reason: ${reason}` : ""}`,
          type: "wallet",
        });
      } catch (notifErr) {
        console.error(
          "[notification] topup rejection failed:",
          notifErr.message,
        );
      }

      res.json({
        success: true,
        message: `Rejected topup request for ${user.email}`,
        transaction: {
          _id: updatedTransaction._id,
          status: "failed",
          amount: updatedTransaction.amount,
          failureReason: reason || "Rejected by admin",
        },
      });
    } else if (action === "pending") {
      res.json({
        success: true,
        message: `Marked topup as pending for ${user.email}`,
        transaction: {
          _id: updatedTransaction._id,
          status: "pending",
          amount: updatedTransaction.amount,
        },
      });
    }
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.settlementReference) {
      return res.status(409).json({ error: "This payment reference has already funded a wallet." });
    }
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.fields });
    console.error("adminVerifyTopup error:", err);
    res.status(500).json({ error: "Failed to verify topup" });
  }
};

/**
 * Admin: Get user wallet info and history
 * GET /api/admin/wallet/user/:userId
 */
exports.adminGetUserWallet = async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const user = await User.findById(userId).select("name email walletBalance");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ user: userId })
        .select("+settlementReference +settlementVerifiedBy +adjustmentKey")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ user: userId }),
    ]);

    res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        walletBalance: user.walletBalance,
      },
      transactions: transactions.map(({ adjustmentKey, ...tx }) => ({
        ...tx, canUndo: tx.source === "admin_adjustment" && tx.status === "success" && Boolean(adjustmentKey) && !tx.undoTransactionId,
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("adminGetUserWallet error:", err);
    res.status(500).json({ error: "Failed to get user wallet" });
  }
};

/**
 * Admin: Search users for wallet tool
 * GET /api/admin/wallet/search?q=email&tier=high|medium|low
 */
exports.adminSearchUsers = async (req, res) => {
  try {
    const { q, tier } = req.query;

    // Build query conditions
    const conditions = [];

    // Text search if provided
    if (q && q.length >= 2) {
      conditions.push({
        $or: [
          { email: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
        ],
      });
    }

    // PATCH_32: Balance tier filter with updated thresholds
    // High: >= $500, Medium: $100-499, Low: < $100
    if (tier) {
      switch (tier) {
        case "high":
          conditions.push({ walletBalance: { $gte: 500 } });
          break;
        case "medium":
          conditions.push({ walletBalance: { $gte: 100, $lt: 500 } });
          break;
        case "low":
          conditions.push({ walletBalance: { $lt: 100 } });
          break;
      }
    }

    // If no conditions, require at least one filter
    if (conditions.length === 0) {
      return res
        .status(400)
        .json({ error: "Provide search query (min 2 chars) or tier filter" });
    }

    const query =
      conditions.length === 1 ? conditions[0] : { $and: conditions };

    const users = await User.find(query)
      .select("name email walletBalance")
      .sort({ walletBalance: -1 })
      .limit(20)
      .lean();

    res.json({
      success: true,
      users,
      filter: { q, tier },
    });
  } catch (err) {
    console.error("adminSearchUsers error:", err);
    res.status(500).json({ error: "Search failed" });
  }
};

/**
 * Admin: Get wallet statistics
 * GET /api/admin/wallet/stats
 */
exports.adminGetStats = async (req, res) => {
  try {
    const [totalBalanceResult, transactionStats, userCounts] =
      await Promise.all([
        User.aggregate([
          { $group: { _id: null, total: { $sum: "$walletBalance" } } },
        ]),
        WalletTransaction.aggregate([
          {
            $group: {
              _id: "$type",
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        // Count users by balance range
        User.aggregate([
          {
            $facet: {
              low: [
                { $match: { walletBalance: { $gte: 0, $lte: 50 } } },
                { $count: "count" },
              ],
              medium: [
                { $match: { walletBalance: { $gt: 50, $lte: 300 } } },
                { $count: "count" },
              ],
              high: [
                { $match: { walletBalance: { $gt: 300 } } },
                { $count: "count" },
              ],
              total: [{ $count: "count" }],
            },
          },
        ]),
      ]);

    const totalBalance = totalBalanceResult[0]?.total || 0;
    const stats = {
      totalBalance,
      credits: { total: 0, count: 0 },
      debits: { total: 0, count: 0 },
      userCounts: {
        low: userCounts[0]?.low[0]?.count || 0,
        medium: userCounts[0]?.medium[0]?.count || 0,
        high: userCounts[0]?.high[0]?.count || 0,
        total: userCounts[0]?.total[0]?.count || 0,
      },
    };

    transactionStats.forEach((s) => {
      if (s._id === "credit") {
        stats.credits = { total: s.total, count: s.count };
      } else if (s._id === "debit") {
        stats.debits = { total: s.total, count: s.count };
      }
    });

    res.json({
      success: true,
      stats,
    });
  } catch (err) {
    console.error("adminGetStats error:", err);
    res.status(500).json({ error: "Failed to get stats" });
  }
};

/**
 * Admin: List all users with wallet balance (paginated with filters)
 * GET /api/admin/wallet/users?balanceLevel=low|medium|high&page=1&limit=20&search=
 */
exports.adminListUsers = async (req, res) => {
  try {
    const {
      balanceLevel,
      page = 1,
      limit = 20,
      search,
      sort = "-walletBalance",
    } = req.query;

    const filter = {};

    // Balance level filter
    if (balanceLevel === "low") {
      filter.walletBalance = { $gte: 0, $lte: 50 };
    } else if (balanceLevel === "medium") {
      filter.walletBalance = { $gt: 50, $lte: 300 };
    } else if (balanceLevel === "high") {
      filter.walletBalance = { $gt: 300 };
    }

    // Search filter
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [{ email: searchRegex }, { name: searchRegex }];
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);

    // Build sort object
    let sortObj = { walletBalance: -1 };
    if (sort === "walletBalance") sortObj = { walletBalance: 1 };
    else if (sort === "-walletBalance") sortObj = { walletBalance: -1 };
    else if (sort === "name") sortObj = { name: 1 };
    else if (sort === "-name") sortObj = { name: -1 };
    else if (sort === "createdAt") sortObj = { createdAt: 1 };
    else if (sort === "-createdAt") sortObj = { createdAt: -1 };

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("_id name email walletBalance createdAt")
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      users,
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / limitNum),
      filterOptions: {
        balanceLevels: [
          { value: "all", label: "All Users" },
          { value: "low", label: "Low Balance (0-50)" },
          { value: "medium", label: "Medium Balance (51-300)" },
          { value: "high", label: "High Balance (300+)" },
        ],
      },
    });
  } catch (err) {
    console.error("adminListUsers error:", err);
    res.status(500).json({ error: "Failed to list users" });
  }
};

/**
 * Process refund to wallet (internal function)
 * Used when orders are cancelled/refunded
 */
exports.processRefund = async (userId, amount, orderId, description = "") => {
  try {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error("Invalid refund amount");
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { walletBalance: numAmount } },
      { new: true },
    );

    if (!user) {
      throw new Error("User not found for refund");
    }

    const previousBalance = user.walletBalance;

    // PATCH_80: Refunds are internal instant operations
    await WalletTransaction.create({
      user: userId,
      type: "credit",
      amount: numAmount,
      source: "refund",
      status: "success", // PATCH_80: Refund is instant
      provider: "internal", // PATCH_80: Internal system operation
      referenceId: orderId,
      description:
        description || `Refund for order #${orderId.toString().slice(-6)}`,
      balanceBefore: previousBalance - numAmount, // was lower before $inc
      balanceAfter: user.walletBalance,
    });

    // PATCH_110: Update lastWalletUpdate
    await User.findByIdAndUpdate(userId, {
      $set: { lastWalletUpdate: new Date() },
    });

    return { success: true, newBalance: user.walletBalance };
  } catch (err) {
    console.error("processRefund error:", err);
    throw err;
  }
};

// ============================================================
// PATCH_110: WITHDRAWAL SYSTEM (MANUAL MODE)
// ============================================================
const WithdrawalRequest = require("../models/WithdrawalRequest");

/**
 * PATCH_110: User requests a withdrawal
 * POST /api/wallet/withdraw
 * Body: { amount }
 *
 * Rules:
 *   - wallet.withdrawable >= amount
 *   - amount >= 10 (minimum withdrawal)
 *   - Creates Transaction(type=withdrawal_request, status=pending)
 *   - $inc wallet.pendingWithdrawals (+amount)
 *   - $inc wallet.withdrawable (-amount)
 */
exports.requestWithdrawal = async (req, res) => {
  try {
    const raw = req.body?.amount;
    const requestId = req.body?.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))) {
      return res.status(400).json({ error: "Invalid withdrawal request ID" });
    }
    const amount = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
    if (!isWalletAmount(amount) || amount < 10) {
      return res.status(400).json({ error: "Minimum withdrawal is $10. Use at most two decimal places." });
    }
    const userId = req.user.id || req.user._id;
    const result = await User.db.transaction(async session => {
      if (requestId) {
        const prior = await WithdrawalRequest.findOne({ userId, requestId }).session(session).lean();
        if (prior) {
          if (prior.amount !== amount) throw Object.assign(new Error("Request ID was used for a different withdrawal amount"), { status: 409 });
          const account = await User.findById(userId).select("walletBalance pendingWithdrawals withdrawable").session(session).lean();
          return { withdrawal: { _id: prior._id, amount, status: prior.status }, withdrawable: availableFunds(account).withdrawable,
            pendingWithdrawals: account.pendingWithdrawals || 0, replayed: true };
        }
      }
      const user = await changeFunds(userId, amount, "reserve", session);
      const [tx] = await WalletTransaction.create([{
        user: userId, type: "debit", amount, source: "withdrawal_request", status: "pending", provider: "internal",
        description: "Withdrawal request for $" + amount.toFixed(2), balanceBefore: user.walletBalance, balanceAfter: null,
      }], { session, ordered: true });
      const [withdrawal] = await WithdrawalRequest.create([{
        userId, amount, requestId, status: "pending", transactionId: tx._id,
      }], { session, ordered: true });
      return { withdrawal: { _id: withdrawal._id, amount, status: "pending" },
        withdrawable: user.withdrawable, pendingWithdrawals: user.pendingWithdrawals, replayed: false };
    });
    res.json({ success: true, message: "Withdrawal request submitted", ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.fields });
    console.error("requestWithdrawal error:", err);
    res.status(500).json({ error: "Failed to submit withdrawal request" });
  }
};

/**
 * PATCH_110: Get user's withdrawal requests
 * GET /api/wallet/withdrawals
 */
exports.getMyWithdrawals = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const withdrawals = await WithdrawalRequest.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ success: true, withdrawals });
  } catch (err) {
    console.error("getMyWithdrawals error:", err);
    res.status(500).json({ error: "Failed to get withdrawals" });
  }
};

/**
 * PATCH_110: Admin — list all withdrawal requests
 * GET /api/admin/wallet/withdrawals
 */
exports.adminGetWithdrawals = async (req, res) => {
  try {
    const { status, before } = req.query;
    const filter = {};
    if (status) {
      if (!["pending", "approved", "rejected", "paid"].includes(status)) return res.status(400).json({ error: "Invalid withdrawal status" });
      filter.status = status;
    }
    if (before !== undefined) {
      const parts = typeof before === "string" && /^(none|\d{1,15})\.([a-f\d]{24})$/i.exec(before);
      if (!parts) return res.status(400).json({ error: "Invalid withdrawal cursor" });
      const createdAt = parts[1] === "none" ? null : new Date(Number(parts[1]));
      filter.$or = [{ createdAt, _id: { $lt: parts[2] } }];
      if (createdAt) filter.$or.push({ createdAt: { $lt: createdAt } }, { createdAt: null });
    }
    const rows = await WithdrawalRequest.find(filter)
      .populate(
        "userId",
        "name email walletBalance withdrawable pendingWithdrawals",
      )
      .populate("reviewedBy", "name email")
      .sort({ createdAt: -1, _id: -1 })
      .limit(101)
      .lean();
    const withdrawals = rows.slice(0, 100);
    const last = withdrawals.at(-1);
    const nextCursor = rows.length > withdrawals.length ? (last.createdAt?.getTime() ?? "none") + "." + last._id : null;
    res.json({ success: true, withdrawals, nextCursor });
  } catch (err) {
    console.error("adminGetWithdrawals error:", err);
    res.status(500).json({ error: "Failed to get withdrawals" });
  }
};

/**
 * PATCH_110: Admin — approve withdrawal (no balance change yet)
 * PUT /api/admin/wallet/withdrawals/:id/approve
 */
exports.adminApproveWithdrawal = async (req, res) => {
  try {
    const { adminNote } = req.body;
    const adminId = req.user._id || req.user.id;

    const withdrawal = await WithdrawalRequest.findOneAndUpdate(
      { _id: req.params.id, status: "pending" },
      {
        $set: {
          status: "approved",
          reviewedAt: new Date(),
          reviewedBy: adminId,
          adminNote: adminNote || "Approved by admin",
        },
      },
      { new: true },
    );

    if (!withdrawal) {
      return res
        .status(404)
        .json({ error: "Withdrawal not found or not pending" });
    }

    res.json({ success: true, message: "Withdrawal approved", withdrawal });
  } catch (err) {
    console.error("adminApproveWithdrawal error:", err);
    res.status(500).json({ error: "Failed to approve withdrawal" });
  }
};

/**
 * PATCH_110: Admin — mark withdrawal as paid
 * PUT /api/admin/wallet/withdrawals/:id/pay
 *
 * Deducts from wallet.balance and wallet.pendingWithdrawals
 * Creates completion transaction
 */
exports.adminMarkWithdrawalPaid = async (req, res) => {
  try {
    const adminId = req.user._id || req.user.id;
    const result = await User.db.transaction(async session => {
      const withdrawal = await WithdrawalRequest.findOne({ _id: req.params.id, status: "approved" }).session(session);
      if (!withdrawal) return null;
      const user = await changeFunds(withdrawal.userId, withdrawal.amount, "payout", session);
      const ledger = {
        user: withdrawal.userId, type: "debit", amount: withdrawal.amount, source: "withdrawal_completed",
        status: "success", provider: "manual", referenceId: withdrawal._id,
        description: "Withdrawal #" + String(withdrawal._id).slice(-6) + " paid out",
        balanceBefore: user.balanceBefore, balanceAfter: user.walletBalance,
      };
      // Finalize the pending row in place so ordinary wallet history has a single
      // successful debit. Some historical requests have no linked transaction.
      let tx;
      if (withdrawal.transactionId) {
        tx = await WalletTransaction.findOneAndUpdate({
          _id: withdrawal.transactionId, user: withdrawal.userId, source: "withdrawal_request", status: "pending",
        }, { $set: ledger }, { new: true, session });
        if (!tx) throw Object.assign(new Error("Withdrawal ledger requires reconciliation"), { status: 409 });
      } else {
        [tx] = await WalletTransaction.create([ledger], { session, ordered: true });
      }
      withdrawal.set({ status: "paid", reviewedAt: new Date(), reviewedBy: adminId, completionTransactionId: tx._id });
      await withdrawal.save({ session });
      return { withdrawal, newBalance: user.walletBalance };
    });
    if (!result) return res.status(404).json({ error: "Withdrawal not found or not approved" });
    const { withdrawal, newBalance } = result;

    // Notify user
    try {
      await sendNotification({
        userId: withdrawal.userId,
        title: "Withdrawal Paid",
        message: `Your withdrawal of $${withdrawal.amount.toFixed(2)} has been processed.`,
        type: "wallet",
      });
    } catch (notifErr) {
      console.error("[notification] withdrawal paid failed:", notifErr.message);
    }

    res.json({
      success: true,
      message: `Withdrawal of $${withdrawal.amount.toFixed(2)} marked as paid`,
      withdrawal,
      newBalance,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.fields });
    console.error("adminMarkWithdrawalPaid error:", err);
    res.status(500).json({ error: "Failed to mark withdrawal as paid" });
  }
};

/**
 * PATCH_110: Admin — reject withdrawal (refund withdrawable)
 * PUT /api/admin/wallet/withdrawals/:id/reject
 */
exports.adminRejectWithdrawal = async (req, res) => {
  try {
    const { adminNote } = req.body;
    const adminId = req.user._id || req.user.id;

    const withdrawal = await User.db.transaction(async session => {
      const record = await WithdrawalRequest.findOne({ _id: req.params.id, status: { $in: ["pending", "approved"] } }).session(session);
      if (!record) return null;
      await changeFunds(record.userId, record.amount, "release", session);
      record.set({ status: "rejected", reviewedAt: new Date(), reviewedBy: adminId, adminNote: adminNote || "Rejected by admin" });
      await record.save({ session });
      if (record.transactionId) await WalletTransaction.updateOne({ _id: record.transactionId }, {
        $set: { status: "failed", failureReason: adminNote || "Withdrawal rejected by admin" },
      }, { session });
      return record;
    });
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found or already processed" });

    res.json({
      success: true,
      message: "Withdrawal rejected and funds restored",
      withdrawal,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.fields });
    console.error("adminRejectWithdrawal error:", err);
    res.status(500).json({ error: "Failed to reject withdrawal" });
  }
};

// ============================================================
// PATCH_110: FINANCE DASHBOARD — LEDGER-DERIVED METRICS
// ============================================================

/**
 * PATCH_110: Admin — Get comprehensive finance metrics
 * GET /api/admin/wallet/finance
 *
 * All values derived from WalletTransaction ledger.
 */
exports.adminGetFinanceMetrics = async (req, res) => {
  try {
    const [
      totalLiabilities,
      pendingWithdrawals,
      lifetimeEarningsPaid,
      purchaseRevenue,
      rentalRevenue,
      topupTotal,
      withdrawalTotal,
      refundTotal,
      txCounts,
    ] = await Promise.all([
      // 1. Sum of all user wallet balances (liabilities)
      User.aggregate([
        { $group: { _id: null, total: { $sum: "$walletBalance" } } },
      ]),
      // 2. Pending withdrawals
      User.aggregate([
        { $group: { _id: null, total: { $sum: "$pendingWithdrawals" } } },
      ]),
      // 3. Total earnings credited (from earning transactions)
      WalletTransaction.aggregate([
        { $match: { source: "earning", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 4. Purchase revenue (service_purchase debits)
      WalletTransaction.aggregate([
        { $match: { source: "service_purchase", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 5. Rental revenue
      WalletTransaction.aggregate([
        {
          $match: {
            source: { $in: ["rental_purchase", "rental_payment"] },
            status: "success",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 6. PayPal + manual topup total
      WalletTransaction.aggregate([
        { $match: { source: "topup", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 7. Withdrawal completions
      WalletTransaction.aggregate([
        { $match: { source: "withdrawal_completed", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 8. Refund total
      WalletTransaction.aggregate([
        { $match: { source: "refund", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // 9. Transaction counts by source
      WalletTransaction.aggregate([
        { $match: { status: "success" } },
        {
          $group: {
            _id: "$source",
            count: { $sum: 1 },
            total: { $sum: "$amount" },
          },
        },
      ]),
    ]);

    const purchaseRev = purchaseRevenue[0]?.total || 0;
    const rentalRev = rentalRevenue[0]?.total || 0;
    const earningsPaid = lifetimeEarningsPaid[0]?.total || 0;
    const withdrawals = withdrawalTotal[0]?.total || 0;
    const refunds = refundTotal[0]?.total || 0;

    // Platform net revenue = purchases + rentals - earnings - withdrawals - refunds
    const platformRevenue =
      purchaseRev + rentalRev - earningsPaid - withdrawals - refunds;

    // Build transaction breakdown from aggregation
    const transactionBreakdown = {};
    txCounts.forEach((t) => {
      transactionBreakdown[t._id] = { count: t.count, total: t.total };
    });

    res.json({
      ok: true,
      finance: {
        totalWalletLiabilities: totalLiabilities[0]?.total || 0,
        pendingWithdrawals: pendingWithdrawals[0]?.total || 0,
        lifetimeEarningsPaid: earningsPaid,
        purchaseRevenue: purchaseRev,
        rentalRevenue: rentalRev,
        topupTotal: topupTotal[0]?.total || 0,
        withdrawalTotal: withdrawals,
        refundTotal: refunds,
        platformRevenue,
        transactionBreakdown,
      },
    });
  } catch (err) {
    console.error("adminGetFinanceMetrics error:", err);
    res.status(500).json({ error: "Failed to get finance metrics" });
  }
};
