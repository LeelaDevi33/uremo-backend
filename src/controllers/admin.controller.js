const Order = require("../models/Order");
const OrderMessage = require("../models/OrderMessage");
const mongoose = require("mongoose");

const { sendEmail } = require("../services/email.service");
const { sendNotification } = require("../services/notification.service");
const {
  orderStatusUpdated,
  paymentVerified,
  welcomeEmail,
} = require("../emails/templates");

// PATCH_31: FlowEngine for orchestrated state transitions
const FlowEngine = require("../core/flowEngine");

// PATCH_23: Affiliate commission processing (using new service)
const {
  processAffiliateCommission,
} = require("../services/affiliateCommission.service");

exports.getAllOrders = async (req, res) => {
  try {
    const statusQuery = String(req.query?.status || "")
      .trim()
      .toLowerCase();

    // Exclude archived cancelled orders by default.
    const query = { isRejectedArchive: { $ne: true } };

    // Optional status filter from UI tabs.
    // PATCH_37: Normalized to 5 statuses: pending, in_progress, waiting_user, completed, cancelled
    const statusMap = {
      pending: "pending",
      in_progress: "in_progress",
      waiting_user: "waiting_user",
      completed: "completed",
      cancelled: "cancelled",
    };

    if (statusQuery && statusQuery !== "all") {
      const mapped = statusMap[statusQuery];
      if (Array.isArray(mapped)) query.status = { $in: mapped };
      else if (mapped) query.status = mapped;
    }

    const orders = await Order.find(query)
      .populate("userId", "email role")
      .populate("serviceId", "title price")
      .populate("payment.methodId", "name type details instructions")
      .sort({ createdAt: -1, updatedAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getRejectedArchivedOrders = async (req, res) => {
  try {
    const orders = await Order.find({ isRejectedArchive: true })
      .populate("userId", "email role")
      .populate("serviceId", "title price")
      .populate("payment.methodId", "name type details instructions")
      .sort({ rejectedAt: -1, updatedAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.archiveRejectedOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // PATCH_37: Support both old "rejected" and new "cancelled" statuses
    if (order.status !== "cancelled" && order.status !== "rejected") {
      return res
        .status(400)
        .json({ message: "Only cancelled orders can be archived" });
    }

    if (!order.isRejectedArchive) {
      order.isRejectedArchive = true;
      order.rejectedAt = new Date();
      order.statusLog = order.statusLog || [];
      order.statusLog.push({
        text: "Order archived to cancelled list",
        at: new Date(),
      });
      order.timeline = order.timeline || [];
      order.timeline.push({
        message: "Order moved to cancelled archive",
        by: "admin",
      });
      await order.save();
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.unarchiveRejectedOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (!order.isRejectedArchive) {
      return res.status(400).json({ message: "Order is not archived" });
    }

    order.isRejectedArchive = false;
    order.rejectedAt = null;
    order.statusLog = order.statusLog || [];
    order.statusLog.push({
      text: "Order unarchived from rejected list",
      at: new Date(),
    });
    order.timeline = order.timeline || [];
    order.timeline.push({
      message: "Order removed from rejected list",
      by: "admin",
    });

    await order.save();
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, reason, note } = req.body;

    const allowed = [
      "pending",
      "in_progress",
      "waiting_user",
      "completed",
      "cancelled",
    ];

    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    // PATCH_37: Admin guardrails - require note for completed
    if (status === "completed" && !note?.trim()) {
      return res.status(400).json({ message: "Completion note required" });
    }

    // PATCH_37: Admin guardrails - require reason for cancelled
    if (status === "cancelled" && !reason?.trim()) {
      return res.status(400).json({ message: "Cancellation reason required" });
    }

    // PATCH_31: Check if transition is allowed via FlowEngine
    const canTransitionResult = await FlowEngine.canTransition(
      "order",
      req.params.id,
      status,
    );
    if (!canTransitionResult.allowed) {
      return res.status(400).json({
        message: canTransitionResult.reason || "Invalid status transition",
        currentStatus: canTransitionResult.currentState,
      });
    }

    // PATCH_37: Use FlowEngine for orchestrated transition with normalized statuses
    const prevStatus = canTransitionResult.currentState;
    let transitionReason = reason;

    if (!transitionReason) {
      if (
        prevStatus === "waiting_user" &&
        ["in_progress", "completed"].includes(status)
      ) {
        transitionReason = "Payment verified by admin";
      } else if (status === "cancelled") {
        transitionReason = "Order cancelled — user must resubmit proof";
      } else {
        transitionReason = `Status changed to: ${status}`;
      }
    }

    const order = await FlowEngine.transition("order", req.params.id, status, {
      actor: "admin",
      adminId: req.user?._id || req.user?.id,
      reason: transitionReason,
    });

    // Send custom email notification (FlowEngine hooks handle in-app notifications)
    if (prevStatus !== status) {
      try {
        await order.populate([
          { path: "userId", select: "email name" },
          { path: "serviceId", select: "title" },
        ]);

        const userEmail = order.userId?.email;
        if (userEmail) {
          await sendEmail({
            to: userEmail,
            subject: "Order status updated — UREMO",
            html: orderStatusUpdated(order),
          });
        }
      } catch (err) {
        console.error("[email] order status hook failed", {
          orderId: String(order?._id || req.params.id),
          message: err?.message || String(err),
        });
      }
    }

    res.json({ message: "Order status updated", order });
  } catch (err) {
    console.error(err);
    // PATCH_31: Return FlowEngine validation errors clearly
    if (err.message?.includes("Invalid transition")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { logAdminAction } = require("../services/adminAudit.service");

    // PATCH-64: First, load the order to check guardrails
    const existingOrder = await Order.findById(req.params.id)
      .populate("payment.methodId", "name type")
      .lean();

    if (!existingOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    // PATCH-64 GUARDRAIL: Check for payment proof
    // PATCH-68: Fixed to check all possible proof field names
    const hasProof =
      existingOrder.payment?.proof ||
      existingOrder.payment?.proofUrl ||
      existingOrder.payment?.transactionId ||
      existingOrder.payment?.screenshotUrl ||
      existingOrder.payment?.reference;

    if (!hasProof && !req.body.skipProofCheck) {
      return res.status(400).json({
        message:
          "Payment proof not found. Cannot verify payment without proof.",
        hint: "User must submit payment proof before verification",
      });
    }

    // PATCH-64 GUARDRAIL: Check for already verified/completed
    if (
      existingOrder.paymentStatus === "paid" ||
      existingOrder.status === "completed"
    ) {
      return res.status(400).json({
        message: "Payment already verified or order completed",
        currentStatus: existingOrder.status,
        paymentStatus: existingOrder.paymentStatus,
      });
    }

    // PATCH_37: Check if transition is allowed via FlowEngine (waiting_user → in_progress)
    const canTransitionResult = await FlowEngine.canTransition(
      "order",
      req.params.id,
      "in_progress",
    );

    if (!canTransitionResult.allowed) {
      if (canTransitionResult.currentState !== "waiting_user") {
        return res.status(400).json({
          message:
            "Payment can only be verified when status is waiting_user (awaiting verification)",
          currentStatus: canTransitionResult.currentState,
        });
      }
      return res.status(400).json({
        message: canTransitionResult.reason || "Invalid status transition",
      });
    }

    // PATCH_37: Use FlowEngine for orchestrated transition to in_progress
    // FlowEngine handles: status update, timeline, affiliate commission (via hooks)
    const order = await FlowEngine.transition(
      "order",
      req.params.id,
      "in_progress",
      {
        actor: "admin",
        adminId: req.user?._id || req.user?.id,
        reason: "Payment verified by admin",
        paymentMethod: "manual",
      },
    );

    // PATCH-64: Log admin action
    await logAdminAction({
      adminId: req.user?._id || req.user?.id,
      adminEmail: req.user?.email,
      action: "payment_verify",
      entityType: "order",
      entityId: String(req.params.id),
      previousState: {
        status: existingOrder.status,
        paymentStatus: existingOrder.paymentStatus,
      },
      newState: { status: "in_progress", paymentStatus: "paid" },
      reason: "Payment verified by admin",
    });

    // Email notification (best-effort, non-blocking)
    // Note: FlowEngine hooks handle in-app notification
    await order.populate([
      { path: "userId", select: "email name role" },
      { path: "serviceId", select: "title price" },
      { path: "payment.methodId", select: "name type details instructions" },
    ]);

    const userEmail = order.userId?.email;
    if (userEmail) {
      setImmediate(async () => {
        try {
          await sendEmail({
            to: userEmail,
            subject: "Payment Verified — Order is Processing",
            html: paymentVerified(order),
          });
        } catch (err) {
          console.error("[email] payment verified hook failed", {
            orderId: String(order?._id || req.params.id),
            message: err?.message || String(err),
          });
        }
      });
    }

    // Return updated order (re-hydrated)
    const updated = await Order.findById(order._id).populate([
      { path: "userId", select: "email name role" },
      { path: "serviceId", select: "title price" },
      { path: "payment.methodId", select: "name type details instructions" },
    ]);

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.testEmail = async (req, res) => {
  try {
    const toEmail = String(req.body?.toEmail || "").trim();
    if (!toEmail) {
      return res.status(400).json({ message: "toEmail is required" });
    }

    const nameGuess = toEmail.split("@")[0] || "there";

    await sendEmail({
      to: toEmail,
      subject: "Welcome to UREMO",
      html: welcomeEmail({ name: nameGuess }),
    });

    res.json({ success: true, message: "Test email sent" });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err?.message || "Email failed" });
  }
};

exports.adminReplyToOrder = async (req, res) => {
  // Backward-compatible admin endpoint.
  // Keep it, but route through the unified chat logic used by users.
  const { postOrderMessage } = require("./orderMessage.controller");
  return postOrderMessage(req, res);
};

exports.getAdminInbox = async (req, res) => {
  try {
    const recent = await OrderMessage.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const byOrder = new Map();
    for (const msg of recent) {
      const key = String(msg.orderId);
      if (!byOrder.has(key)) {
        byOrder.set(key, msg);
      }
    }

    const orderIds = Array.from(byOrder.keys());

    // Compute unread counts for each order (user -> admin messages not yet seen)
    const orderObjectIds = orderIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const unreadAgg = await OrderMessage.aggregate([
      {
        $match: {
          orderId: { $in: orderObjectIds },
          senderRole: "user",
          status: { $ne: "seen" },
        },
      },
      { $group: { _id: "$orderId", count: { $sum: 1 } } },
    ]);
    const unreadMap = new Map(
      (Array.isArray(unreadAgg) ? unreadAgg : []).map((x) => [
        String(x._id),
        Number(x.count || 0),
      ]),
    );

    const orders = await Order.find({ _id: { $in: orderIds } })
      .populate("userId", "email")
      .populate("serviceId", "title")
      .lean();

    const orderMap = new Map(orders.map((o) => [String(o._id), o]));

    const items = orderIds
      .map((orderId) => {
        const last = byOrder.get(orderId);
        const order = orderMap.get(orderId);
        if (!order) return null;

        return {
          orderId,
          lastMessage: last.message,
          lastAt: last.createdAt,
          status: order.status,
          userEmail: order.userId?.email || "",
          serviceTitle: order.serviceId?.title || "",
          unreadCount: unreadMap.get(orderId) || 0,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
      );

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

exports.getAdminUnreadSnapshot = async (req, res) => {
  try {
    const agg = await OrderMessage.aggregate([
      {
        $match: {
          senderRole: "user",
          status: { $ne: "seen" },
        },
      },
      { $group: { _id: "$orderId", count: { $sum: 1 } } },
    ]);

    const byOrder = {};
    let totalUnread = 0;
    for (const row of Array.isArray(agg) ? agg : []) {
      const key = String(row._id);
      const count = Number(row.count || 0);
      byOrder[key] = count;
      totalUnread += count;
    }

    res.json({ totalUnread, byOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err?.message || "Server error" });
  }
};

exports.markOrderSupportRead = async (req, res) => {
  try {
    const id = String(req.params?.id || "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid order id" });
    }

    const result = await OrderMessage.updateMany(
      {
        orderId: new mongoose.Types.ObjectId(id),
        senderRole: "user",
        status: { $ne: "seen" },
      },
      { $set: { status: "seen", seenAt: new Date() } },
    );

    res.json({ ok: true, updated: result?.modifiedCount || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err?.message || "Server error" });
  }
};

exports.addOrderNote = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ message: "Note message is required" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    order.timeline.push({
      message,
      by: "admin",
    });
    await order.save();

    res.json({ message: "Note added", order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Get all users (admin)
 * GET /api/admin/users
 */
exports.getAllUsers = async (req, res) => {
  try {
    const User = require("../models/User");

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();

    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password -__v")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    res.json({
      users,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[admin] getAllUsers error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
