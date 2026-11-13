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
 * PATCH_80: Initiate wallet topup (NO INSTANT CREDIT)
 * PATCH_81: Added duplicate request protection
 * POST /api/wallet/topup
 * Body: { amount }
 *
 * This creates a transaction with status='initiated'.
 * Balance is NOT updated here - it only updates when admin verifies
 * or when payment gateway confirms (future).
 *
 * Flow:
 * 1. User requests topup → status = 'initiated'
 * 2. User pays via gateway (future) or manual verification
 * 3. Admin or webhook verifies → status = 'success', balance updated
 */
exports.topUp = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    const numAmount = typeof amount === "string" ? Number(amount) : amount;
    if (!isWalletAmount(numAmount) || numAmount < 1) {
      return res.status(400).json({ error: "Minimum top-up amount is $1" });
    }

    const userId = req.user.id || req.user._id;

    // Verify user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // PATCH_81: Prevent duplicate rapid requests (within 10 seconds for same amount)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    const recentDuplicate = await WalletTransaction.findOne({
      user: userId,
      source: "topup",
      amount: numAmount,
      status: { $in: ["initiated", "pending"] },
      createdAt: { $gte: tenSecondsAgo },
    });

    if (recentDuplicate) {
      return res.status(409).json({
        error: "Duplicate request - a similar topup was just submitted",
        existingTransactionId: recentDuplicate._id,
        retryAfter: 10000,
      });
    }

    // PATCH_80: Create transaction with status='initiated' (NO balance change)
    const transaction = await WalletTransaction.create({
      user: userId,
      type: "credit",
      amount: numAmount,
      source: "topup",
      status: "initiated", // CRITICAL: Not 'success' - no balance change yet
      provider: "manual", // Phase 1: Manual verification by admin
      providerRef: null,
      description: "Wallet top-up (pending verification)",
      balanceBefore: user.walletBalance || 0,
      balanceAfter: null, // Will be set when verified
    });

    // In future: redirect to payment gateway here
    // For now: user sees "pending" and admin must verify

    res.json({
      success: true,
      message: "Top-up request submitted. Pending verification.",
      transactionId: transaction._id,
      status: "initiated",
      amount: numAmount,
      // DO NOT return updated balance - it hasn't changed
      currentBalance: user.walletBalance,
    });
  } catch (err) {
    console.error("topUp error:", err);
    res.status(500).json({ error: "Failed to initiate top-up" });
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

// ============================================================
// PATCH_82: PayPal Wallet Top-Up (International, Safe Mode)
// ============================================================
const {
  client: paypalClient,
  paypal,
  isConfigured: isPayPalConfigured,
} = require("../config/paypal");

/**
 * PATCH_82: Create PayPal order for wallet top-up
 * POST /api/wallet/topup/paypal/create
 * Body: { amount }
 *
 * Creates a PayPal order and returns the approval URL.
 * Transaction is stored with status='initiated', provider='paypal'.
 * NO wallet credit happens here.
 */
exports.createPayPalTopup = async (req, res) => {
  try {
    // Check if PayPal is configured
    if (!isPayPalConfigured()) {
      return res.status(503).json({
        error: "PayPal is not configured on this server",
      });
    }

    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 1) {
      return res.status(400).json({ error: "Minimum top-up amount is $1" });
    }

    const userId = req.user.id || req.user._id;

    // Verify user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // PATCH_81: Prevent duplicate rapid requests (within 10 seconds for same amount)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    const recentDuplicate = await WalletTransaction.findOne({
      user: userId,
      source: "topup",
      provider: "paypal",
      amount: numAmount,
      status: { $in: ["initiated", "pending"] },
      createdAt: { $gte: tenSecondsAgo },
    });

    if (recentDuplicate) {
      return res.status(409).json({
        error: "Duplicate request - a similar PayPal topup was just submitted",
        existingTransactionId: recentDuplicate._id,
        retryAfter: 10000,
      });
    }

    // Create PayPal order
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: numAmount.toFixed(2),
          },
          description: `UREMO Wallet Top-Up - $${numAmount.toFixed(2)}`,
        },
      ],
      application_context: {
        brand_name: "UREMO",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
        return_url: `${process.env.FRONTEND_URL || "https://uremo.online"}/wallet?paypal=success`,
        cancel_url: `${process.env.FRONTEND_URL || "https://uremo.online"}/wallet?paypal=cancelled`,
      },
    });

    const paypalOrder = await paypalClient.execute(request);

    // Store transaction with PayPal order ID
    const transaction = await WalletTransaction.create({
      user: userId,
      type: "credit",
      amount: numAmount,
      source: "topup",
      status: "initiated", // CRITICAL: Not 'success' - no balance change yet
      provider: "paypal",
      providerRef: paypalOrder.result.id, // PayPal Order ID
      description: "Wallet top-up via PayPal (pending verification)",
      balanceBefore: user.walletBalance || 0,
      balanceAfter: null, // Will be set when admin verifies
    });

    // Get approval URL from PayPal response
    const approvalLink = paypalOrder.result.links.find(
      (link) => link.rel === "approve",
    );

    res.json({
      success: true,
      message: "PayPal order created. Redirect user to approve.",
      transactionId: transaction._id,
      paypalOrderId: paypalOrder.result.id,
      approvalUrl: approvalLink?.href,
      status: "initiated",
      amount: numAmount,
      currentBalance: user.walletBalance,
    });
  } catch (err) {
    console.error("createPayPalTopup error:", err);
    res.status(500).json({
      error: "Failed to create PayPal order",
      details: err.message,
    });
  }
};

/**
 * PATCH_82: Confirm PayPal payment (after user approves on PayPal)
 * POST /api/wallet/topup/paypal/confirm
 * Body: { paypalOrderId }
 *
 * Captures the PayPal payment and marks transaction as 'paid_unverified'.
 * STILL NO wallet credit - admin must verify.
 */
exports.confirmPayPalTopup = async (req, res) => {
  try {
    if (!isPayPalConfigured()) {
      return res.status(503).json({
        error: "PayPal is not configured on this server",
      });
    }

    const { paypalOrderId } = req.body;

    if (!paypalOrderId) {
      return res.status(400).json({ error: "PayPal Order ID required" });
    }

    const userId = req.user.id || req.user._id;

    // Find the transaction by PayPal order ID
    const transaction = await WalletTransaction.findOne({
      user: userId,
      provider: "paypal",
      providerRef: paypalOrderId,
    });

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if already processed
    if (transaction.status === "paid_unverified") {
      return res.status(200).json({
        success: true,
        message: "Payment already confirmed. Awaiting admin verification.",
        alreadyConfirmed: true,
        transactionId: transaction._id,
        status: transaction.status,
      });
    }

    if (transaction.status === "success") {
      return res.status(200).json({
        success: true,
        message: "Transaction already completed.",
        alreadyProcessed: true,
        transactionId: transaction._id,
      });
    }

    if (transaction.status === "failed") {
      return res.status(400).json({
        error: "Transaction was cancelled or failed",
      });
    }

    // Capture the PayPal payment
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});

    const capture = await paypalClient.execute(request);

    if (capture.result.status !== "COMPLETED") {
      // Payment not completed
      await WalletTransaction.findByIdAndUpdate(transaction._id, {
        status: "failed",
        failureReason: `PayPal payment not completed: ${capture.result.status}`,
      });
      return res.status(400).json({
        error: `PayPal payment not completed: ${capture.result.status}`,
      });
    }

    // ATOMIC update to paid_unverified (prevents race with webhook)
    const updatedTx = await WalletTransaction.findOneAndUpdate(
      {
        _id: transaction._id,
        status: { $in: ["initiated", "pending"] },
      },
      {
        $set: {
          status: "paid_unverified",
          description: `PayPal payment captured (ID: ${capture.result.id}). Awaiting admin verification.`,
        },
      },
      { new: true },
    );

    if (!updatedTx) {
      // Already processed by webhook or another request
      const existing = await WalletTransaction.findById(transaction._id);
      return res.status(200).json({
        success: true,
        message: "Payment already processed.",
        transactionId: existing._id,
        status: existing.status,
        alreadyProcessed: true,
      });
    }

    // CRITICAL: NO wallet balance change here
    // Balance only updates when admin verifies

    res.json({
      success: true,
      message: "PayPal payment confirmed. Awaiting admin verification.",
      transactionId: updatedTx._id,
      status: "paid_unverified",
      amount: updatedTx.amount,
      // DO NOT return updated balance - it hasn't changed
    });
  } catch (err) {
    console.error("confirmPayPalTopup error:", err);

    // Handle PayPal capture errors
    if (err.statusCode === 422) {
      return res.status(400).json({
        error:
          "PayPal order cannot be captured. It may be expired or cancelled.",
      });
    }

    res.status(500).json({
      error: "Failed to confirm PayPal payment",
      details: err.message,
    });
  }
};

/**
 * PATCH_82: Check if PayPal is available
 * GET /api/wallet/topup/paypal/available
 */
exports.isPayPalAvailable = async (req, res) => {
  res.json({
    success: true,
    available: isPayPalConfigured(),
  });
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

/**
 * Admin: Adjust user wallet balance
 * POST /api/admin/wallet/adjust
 * Body: { userId, amount, type, description }
 * PATCH-64: Enhanced with guardrails and audit logging
 */
exports.adminAdjustBalance = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");
    const { userId, amount, type, description } = req.body;

    if (!userId || !amount || !type) {
      return res.status(400).json({
        error: "userId, amount, and type (credit/debit) required",
      });
    }

    if (!["credit", "debit"].includes(type)) {
      return res.status(400).json({ error: "Type must be credit or debit" });
    }

    const numAmount = typeof amount === "string" ? Number(amount) : amount;
    if (!isWalletAmount(numAmount)) return res.status(400).json({ error: "Use a positive USD amount with at most two decimals" });

    // PATCH-64 GUARDRAIL: Require description/reason for all adjustments
    if (!description || description.trim().length < 5) {
      return res.status(400).json({
        error: "Description is required (minimum 5 characters)",
        hint: "Provide a reason for this wallet adjustment",
      });
    }

    if (numAmount > 1000) {
      console.warn("[AUDIT] Large wallet adjustment", { userId, amount: numAmount, type, adminId: req.user.id });
    }
    const updatedUser = await User.db.transaction(async session => {
      const funds = await changeFunds(userId, numAmount, type === "credit" ? "credit" : "spend", session);
      await WalletTransaction.create([{
        user: userId, type, amount: numAmount, source: "admin_adjustment", status: "success", provider: "manual",
        description, balanceBefore: funds.balanceBefore, balanceAfter: funds.walletBalance,
      }], { session, ordered: true });
      const identity = await User.findById(userId).select("name email").session(session).lean();
      return { ...funds, ...identity };
    });
    const previousBalance = updatedUser.balanceBefore;

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: type === "credit" ? "wallet_credit" : "wallet_debit",
      entityType: "wallet",
      entityId: String(userId),
      previousState: { balance: previousBalance },
      newState: { balance: updatedUser.walletBalance },
      reason: description,
      metadata: { amount: numAmount, type },
    });

    // PATCH_29: Notify user about wallet update
    try {
      const action = type === "credit" ? "credited" : "debited";
      await sendNotification({
        userId: userId,
        title: "Wallet Update",
        message: `Your wallet has been ${action} $${numAmount.toFixed(2)}. New balance: $${updatedUser.walletBalance.toFixed(2)}`,
        type: "wallet",
      });
    } catch (notifErr) {
      console.error(
        "[notification] wallet adjustment failed:",
        notifErr.message,
      );
    }

    res.json({
      success: true,
      message: `Successfully ${type}ed $${numAmount.toFixed(2)} ${type === "credit" ? "to" : "from"} user wallet`,
      user: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        walletBalance: updatedUser.walletBalance,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status === 402 ? 400 : err.status).json({ error: err.message, ...err.fields });
    console.error("adminAdjustBalance error:", err);
    res.status(500).json({ error: "Failed to adjust balance" });
  }
};

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
        status: { $in: ["initiated", "pending", "paid_unverified"] },
      })
        .populate("user", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({
        source: "topup",
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
      if (transaction.source !== "topup") fail(400, "Only topup transactions can be verified");
      if (!["initiated", "pending", "paid_unverified"].includes(transaction.status)) {
        fail(400, "Transaction already processed", { alreadyProcessed: true });
      }
      const user = await User.findById(transaction.user).select("name email").session(session).lean();
      if (!user) fail(404, "User not found");
      const previousStatus = transaction.status;
      let updatedUser;
      if (action === "approve") {
        if (transaction.provider === "manual" || transaction.provider === "internal") {
          const reference = typeof req.body.settlementReference === "string" ? req.body.settlementReference.trim().toUpperCase() : "";
          if (!/^[A-Z0-9][A-Z0-9._/-]{3,79}$/.test(reference)) {
            fail(400, "Enter the unique reference from the verified payment record (4–80 letters, digits, dots, slashes, underscores or hyphens).");
          }
          transaction.set({ settlementReference: reference, settlementVerifiedBy: req.user.id });
        }
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
        .select("+settlementReference +settlementVerifiedBy")
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
      transactions,
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
    const { status } = req.query;
    const filter = {};
    if (
      status &&
      ["pending", "approved", "rejected", "paid"].includes(status)
    ) {
      filter.status = status;
    }

    const withdrawals = await WithdrawalRequest.find(filter)
      .populate(
        "userId",
        "name email walletBalance withdrawable pendingWithdrawals",
      )
      .populate("reviewedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, withdrawals });
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
