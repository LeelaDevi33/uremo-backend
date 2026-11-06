const mongoose = require("mongoose");
const Order = require("../models/Order");
const OrderMessage = require("../models/OrderMessage");
const { orderChatDenial } = require("../services/orderChatPolicy");

// In-memory SSE subscribers: orderId -> Set(res)
const subscribersByOrderId = new Map();

function addSubscriber(orderId, res) {
  const key = String(orderId);
  if (!subscribersByOrderId.has(key)) {
    subscribersByOrderId.set(key, new Set());
  }
  subscribersByOrderId.get(key).add(res);
}

function removeSubscriber(orderId, res) {
  const key = String(orderId);
  const set = subscribersByOrderId.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) subscribersByOrderId.delete(key);
}

function broadcastMessage(order, payload) {
  const key = String(order._id);
  const set = subscribersByOrderId.get(key);
  if (!set || set.size === 0) return;

  const eventId = payload?._id ? String(payload._id) : String(Date.now());
  // Default event type is "message" when no `event:` line is provided.
  const data = `id: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(set)) {
    try {
      const user = res.req.user;
      if (orderChatDenial(order, user?.id, user?.role === "admin")) {
        set.delete(res);
        res.end();
        continue;
      }
      res.write(data);
    } catch (e) {
      // Best-effort cleanup
      try {
        res.end();
      } catch (closeErr) {}

      set.delete(res);
    }
  }

  if (set.size === 0) subscribersByOrderId.delete(key);
}

async function assertOrderAccess(req, res) {
  if (!req.user || !req.user.id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }

  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: "Invalid order id" });
    return null;
  }

  const order = await Order.findById(id);
  const denial = orderChatDenial(order, req.user.id, req.user.role === "admin");
  if (denial === "ORDER_NOT_FOUND") {
    res.status(404).json({ message: "Order not found" });
    return null;
  }

  if (denial === "FORBIDDEN") {
    res.status(403).json({ message: "Access denied" });
    return null;
  }

  if (denial === "CHAT_UNAVAILABLE") {
    res.status(400).json({ message: "Order chat is unavailable for this status.", orderStatus: order.status });
    return null;
  }

  return order;
}

exports.streamOrderMessages = async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user?.id || "anon";
  const role = req.user?.role || "unknown";

  try {
    // Validate access up-front
    const order = await assertOrderAccess(req, res);
    if (!order) return;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Let proxies know we're streaming
    res.flushHeaders?.();

    // Tell the client how soon to retry if the connection drops.
    res.write(`retry: 5000\n`);
    // Initial heartbeat
    res.write(`: connected\n\n`);

    addSubscriber(order._id, res);

    const pingMs = 25_000;
    const pingTimer = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // will be handled by close
      }
    }, pingMs);

    req.on("close", () => {
      clearInterval(pingTimer);
      removeSubscriber(order._id, res);
      try {
        res.end();
      } catch (closeErr) {}
    });
  } catch (err) {
    console.error(
      `[CHAT_STREAM_FAIL] orderId=${orderId} userId=${userId} role=${role} errMessage=${err?.message}`,
    );
    // If headers not sent, return safe JSON.
    if (!res.headersSent) {
      return res.status(500).json({ message: "Unable to open message stream" });
    }
    try {
      res.end();
    } catch (closeErr) {}
  }
};

exports.getOrderMessages = async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user?.id || "anon";
  const role = req.user?.role || "unknown";

  try {
    const order = await assertOrderAccess(req, res);
    if (!order) return;

    const messages = await OrderMessage.find({ orderId: order._id })
      .sort({ createdAt: 1 })
      .lean();

    const list = Array.isArray(messages) ? messages : [];

    // Keep legacy shape (_id) + provide stable id + include attachments
    const normalized = list.map((m) => ({
      _id: m._id,
      id: m._id,
      orderId: m.orderId,
      senderRole: m.senderRole,
      message: m.message,
      attachments: m.attachments || [],
      createdAt: m.createdAt,
    }));

    res.json(normalized);
  } catch (err) {
    console.error(
      `[CHAT_GET_FAIL] orderId=${orderId} userId=${userId} role=${role} errMessage=${err?.message}`,
    );
    // Requirement: never crash chat GET. Return [] rather than 500.
    return res.json([]);
  }
};

exports.postOrderMessage = async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user?.id || "anon";
  const role = req.user?.role || "unknown";

  try {
    const order = await assertOrderAccess(req, res);
    if (!order) return;

    const message = String(req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }
    if (message.length > 2000) {
      return res
        .status(400)
        .json({ message: "Message too long (max 2000 characters)" });
    }

    const senderRole = req.user?.role === "admin" ? "admin" : "user";

    // Avoid throwing on invalid ids; let mongoose cast when possible.
    const rawSenderId = req.user?.id ?? null;
    if (
      typeof rawSenderId === "string" &&
      !mongoose.Types.ObjectId.isValid(rawSenderId)
    ) {
      return res.status(401).json({ message: "Invalid token" });
    }

    // Validate attachments array if provided
    const attachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments.filter(
          (att) =>
            att &&
            typeof att.url === "string" &&
            typeof att.filename === "string" &&
            typeof att.fileType === "string",
        )
      : [];

    const created = await OrderMessage.create({
      orderId: order._id,
      senderId: rawSenderId,
      userId: rawSenderId,
      senderRole,
      message,
      attachments,
      status: "sent",
      createdAt: new Date(),
    });

    console.log(
      `[CHAT_SEND_OK] orderId=${orderId} userId=${userId} role=${senderRole}`,
    );

    const payload = {
      _id: created._id,
      id: created._id,
      orderId: order._id,
      senderId: created.senderId,
      senderRole: created.senderRole,
      message: created.message,
      attachments: created.attachments || [],
      status: created.status || "sent",
      createdAt: created.createdAt,
      deliveredAt: created.deliveredAt || null,
      seenAt: created.seenAt || null,
    };

    // Broadcast to all SSE subscribers for this order
    broadcastMessage(order, payload);

    // Best-effort Socket.IO broadcast (so REST fallback still updates realtime chat)
    try {
      const { getIO, broadcastOrderMessage } = require("../socket");
      const io = getIO();
      if (io) {
        broadcastOrderMessage(order, payload);
        if (senderRole === "user") {
          io.to("admin:orders").emit("admin:order_message", {
            orderId: String(order._id),
            message: payload,
          });
        }
      }
    } catch {
      // ignore broadcast errors
    }

    return res.status(201).json(payload);
  } catch (err) {
    const errName = err?.name;
    const errCode = err?.code;
    console.error(
      `[CHAT_SEND_FAIL] orderId=${orderId} userId=${userId} role=${role} errName=${errName} errCode=${errCode} errMessage=${err?.message}`,
    );

    if (errName === "ValidationError") {
      const firstKey = err?.errors ? Object.keys(err.errors)[0] : null;
      const firstMsg = firstKey ? err.errors[firstKey]?.message : null;
      return res.status(400).json({ message: firstMsg || "Invalid message" });
    }

    if (errName === "CastError") {
      return res.status(400).json({ message: "Invalid request" });
    }

    return res.status(500).json({ message: "Unable to send message" });
  }
};
