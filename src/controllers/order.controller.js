const Order = require("../models/Order");
const Service = require("../models/Service");
const User = require("../models/User");
const OrderMessage = require("../models/OrderMessage");
const mongoose = require("mongoose");
const { canReadRentalAccess } = require("../utils/rentalAccess");

// PATCH_38: Action rules enforcement
const {
  getAllowedActionsForService,
  getEffectiveCategoryFromService,
} = require("../config/categoryActions");

const { sendEmail, getAdminEmails } = require("../services/email.service");
const {
  paymentSubmitted,
  adminPaymentProofAlert,
  adminNewOrderAlert,
} = require("../emails/templates");
const { normalizeCloudinaryUrl } = require("../utils/cloudinaryUrl");

function fireAndForget(task, meta) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error("[email] async hook failed", {
          ...(meta || {}),
          message: err?.message || String(err),
        });
      });
  });
}

exports.createOrder = async (req, res) => {
  try {
    const service = await Service.findById(req.body.serviceId);

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    const allowed =
      service.allowedActions && typeof service.allowedActions === "object"
        ? service.allowedActions
        : getAllowedActionsForService(service);
    if (!allowed.buy) {
      return res
        .status(403)
        .json({ ok: false, error: "BUY_NOT_ALLOWED", message: "Buying is not available for this service" });
    }

    const order = await Order.create({
      userId: req.user.id,
      serviceId: req.body.serviceId,
      status: "pending",
      orderType: "buy",
      quotedAmount: service.price,
      quotedCurrency: service.currency || "USD",
      reminderSent: false,
      payment: null,
      paidAt: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      statusLog: [
        {
          text: "Order reserved (pending payment)",
          at: new Date(),
        },
      ],
      timeline: [
        {
          message: "Order reserved (pending payment)",
          by: "system",
        },
      ],
    });

    // Email notifications (best-effort, non-blocking)
    const orderId = String(order._id);
    const userId = String(req.user.id);
    const serviceTitle = service?.title || "Service";
    fireAndForget(
      async () => {
        const admins = getAdminEmails();
        if (!admins.length) return;

        const user = await User.findById(userId).select("email").lean();
        await sendEmail({
          to: admins,
          subject: "Admin alert: new order created",
          html: adminNewOrderAlert({
            _id: orderId,
            status: "pending",
            userEmail: user?.email || "",
            serviceTitle,
          }),
        });
      },
      { hook: "adminNewOrderAlert", orderId },
    );

    // PATCH_39: Return full order data for immediate UI binding
    res.json({ ok: true, orderId: order._id, order });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

// PATCH_38: Create Deal Order
// POST /api/orders/deal
// Body: { serviceId, dealPercent }
exports.createDealOrder = async (req, res) => {
  try {
    const { serviceId, dealPercent } = req.body || {};
    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ message: "Service not found" });

    const allowed =
      service.allowedActions && typeof service.allowedActions === "object"
        ? service.allowedActions
        : getAllowedActionsForService(service);
    if (!allowed.deal) {
      return res
        .status(403)
        .json({ ok: false, error: "DEAL_NOT_ALLOWED", message: "Deals are not available for this service" });
    }

    // Extra safety: forex must never be eligible
    const effectiveCategory = getEffectiveCategoryFromService(service);
    if (effectiveCategory === "forex_accounts") {
      return res
        .status(403)
        .json({ ok: false, error: "DEAL_NOT_ALLOWED", message: "Deals are not available for forex services" });
    }

    const pct = Number(dealPercent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return res
        .status(400)
        .json({ message: "dealPercent must be a number between 1 and 100" });
    }

    const order = await Order.create({
      userId: req.user.id,
      serviceId,
      status: "pending",
      orderType: "deal",
      quotedAmount: service.price,
      quotedCurrency: service.currency || "USD",
      dealPercent: pct,
      notes: `Deal: ${pct}% - ${service.title}`,
      reminderSent: false,
      payment: null,
      paidAt: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      statusLog: [
        {
          text: `Deal order created (${pct}%)`,
          at: new Date(),
        },
      ],
      timeline: [
        {
          message: `Deal order created (${pct}%)`,
          by: "system",
        },
      ],
    });

    // PATCH_39: Return full order data for immediate UI binding
    res.json({ ok: true, orderId: order._id, order });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.myOrders = async (req, res) => {
  try {
    // PATCH_39: Ensure userId extraction works with both id and _id
    const userId = req.user.id || req.user._id;
    const orders = await Order.find({ userId })
      .populate("serviceId", "title price currency category imageUrl")
      .populate("rentalId", "price currency")
      .populate("payment.methodId", "name type")
      .sort({ createdAt: -1 })
      .lean();

    // Fetch last message for each order to detect unread admin replies
    const orderIds = orders.map((o) => o._id);
    const lastMessages = await OrderMessage.aggregate([
      { $match: { orderId: { $in: orderIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$orderId",
          lastMessage: { $first: "$$ROOT" },
        },
      },
    ]);

    const lastMessageMap = new Map();
    for (const item of lastMessages) {
      lastMessageMap.set(String(item._id), item.lastMessage);
    }

    const result = orders.map((order) => {
      if (order?.payment?.proofUrl) {
        const proofFormat = order.payment.proofFormat;
        const proofResourceType = order.payment.proofResourceType;
        const mimeType = proofFormat
          ? proofResourceType === "raw"
            ? `application/${proofFormat}`
            : `image/${proofFormat}`
          : undefined;
        order.payment.proofUrl = normalizeCloudinaryUrl(
          order.payment.proofUrl,
          {
            resourceType: proofResourceType,
            mimeType,
          },
        );
      }

      // Attach last message info for unread badge detection
      const lastMsg = lastMessageMap.get(String(order._id));
      if (lastMsg) {
        order.lastMessage = {
          _id: lastMsg._id,
          senderRole: lastMsg.senderRole,
          createdAt: lastMsg.createdAt,
        };
      }

      return order;
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    // Avoid CastError -> 500. Treat invalid ids as not found.
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Order not found" });
    }

    const order = await Order.findById(id)
      .populate("serviceId", "title price currency")
      .populate("payment.methodId")
      .populate("rentalId", "rentalType duration price currency startDate endDate status daysRemaining accessDetails user order activatedAt cancelledAt expiredAt statusLog");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // User can only view their own orders (admins can view any)
    const isAdmin = req.user?.role === "admin" && await User.exists({ _id: req.user.id, role: "admin" });
    if (!isAdmin && order.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (order?.payment?.proofUrl) {
      const proofFormat = order.payment.proofFormat;
      const proofResourceType = order.payment.proofResourceType;
      const mimeType = proofFormat
        ? proofResourceType === "raw"
          ? `application/${proofFormat}`
          : `image/${proofFormat}`
        : undefined;
      order.payment.proofUrl = normalizeCloudinaryUrl(order.payment.proofUrl, {
        resourceType: proofResourceType,
        mimeType,
      });
    }

    const result = order.toObject();
    if (result.rentalId) {
      const rental = result.rentalId;
      if (!isAdmin && (String(rental.user) !== String(req.user.id) || String(rental.order) !== String(order._id))) {
        result.rentalId = null;
      } else {
        if (!isAdmin && !canReadRentalAccess(rental, order, req.user.id)) delete rental.accessDetails;
        // These fields were only selected to verify access.
        delete rental.user;
        delete rental.order;
        delete rental.activatedAt;
        delete rental.cancelledAt;
        delete rental.expiredAt;
        delete rental.statusLog;
      }
    }
    res.set("Cache-Control", "private, no-store").json(result);
  } catch (err) {
    if (err?.name === "CastError") {
      return res.status(404).json({ message: "Order not found" });
    }
    res.status(500).json({ message: err?.message || "Server error" });
  }
};

exports.submitPayment = async (req, res) => {
  try {
    const {
      methodId,
      reference,
      proofUrl,
      proofPublicId,
      proofResourceType,
      proofFormat,
      publicId,
      resourceType,
      format,
    } = req.body;
    const { id } = req.params;

    if (!methodId || !proofUrl) {
      return res
        .status(400)
        .json({ message: "Payment method and proof are required" });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Ownership check
    if (order.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Prevent resubmission unless cancelled
    if (order.status === "waiting_user") {
      return res
        .status(400)
        .json({ message: "Payment already submitted for this order" });
    }

    if (!["pending", "cancelled"].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot submit payment for an order in status: ${order.status}`,
      });
    }

    if (
      order.status === "pending" &&
      order.expiresAt &&
      Date.now() > new Date(order.expiresAt).getTime()
    ) {
      order.statusLog = order.statusLog || [];
      order.statusLog.push({
        text: "Order expired (payment not submitted in time)",
        at: new Date(),
      });
      await order.save();
      return res.status(410).json({
        message: "Order reservation expired. Please buy the service again.",
      });
    }

    const resolvedPublicId = proofPublicId || publicId || "";
    const resolvedResourceType = proofResourceType || resourceType || "";
    const resolvedFormat = proofFormat || format || "";
    const resolvedProofUrl = normalizeCloudinaryUrl(proofUrl, {
      resourceType: resolvedResourceType,
    });

    // Update order with payment info - status goes to waiting_user (awaiting admin verification)
    order.payment = {
      methodId,
      reference: reference || "",
      proofUrl: resolvedProofUrl,
      proofPublicId: resolvedPublicId || undefined,
      proofResourceType: resolvedResourceType || undefined,
      proofFormat: resolvedFormat || undefined,
      submittedAt: new Date(),
    };
    order.status = "waiting_user";
    order.expiresAt = null;
    order.statusLog = order.statusLog || [];
    order.statusLog.push({
      text: "Payment proof submitted (awaiting verification)",
      at: new Date(),
    });
    order.timeline.push({
      message: "Payment submitted for verification",
      by: "system",
    });

    await order.save();

    // Email notifications (best-effort, non-blocking)
    const orderId = String(order._id);
    fireAndForget(
      async () => {
        const hydratedOrder = await Order.findById(orderId).populate([
          { path: "userId", select: "email name" },
          { path: "serviceId", select: "title" },
        ]);
        if (!hydratedOrder) return;

        const userEmail = hydratedOrder.userId?.email;
        const serviceTitle = hydratedOrder.serviceId?.title || "Service";

        if (userEmail) {
          await sendEmail({
            to: userEmail,
            subject: "Payment proof received — UREMO",
            html: paymentSubmitted(hydratedOrder),
          });
        }

        const admins = getAdminEmails();
        if (admins.length) {
          await sendEmail({
            to: admins,
            subject: "Admin alert: payment proof submitted",
            html: adminPaymentProofAlert({
              _id: orderId,
              status: hydratedOrder.status,
              userEmail: userEmail || "",
              serviceTitle,
            }),
          });
        }
      },
      { hook: "paymentSubmitted", orderId },
    );

    res.json({
      message: "Payment submitted for verification",
      order,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
