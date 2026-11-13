const { tokenIdentity, liveAdminIds } = require("../services/tokenIdentity");
/**
 * Socket.io server setup and event handlers for realtime chat.
 */
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Order = require("../models/Order");
const OrderMessage = require("../models/OrderMessage");
const mongoose = require("mongoose");
const { isAllowedOrigin, checkCorsOrigin } = require("../config/browserOrigins");
const { orderChatDenial } = require("../services/orderChatPolicy");

let io = null;

// In-memory socket health logs (best-effort, process-local)
const SOCKET_LOG_LIMIT = 200;
const socketLogs = [];

function pushSocketLog(tag, meta) {
  const entry = {
    ts: new Date().toISOString(),
    tag: String(tag || ""),
    ...(meta && typeof meta === "object" ? meta : {}),
  };
  socketLogs.push(entry);
  if (socketLogs.length > SOCKET_LOG_LIMIT) socketLogs.shift();

  // Also print a concise console line for Render logs.
  const parts = [];
  if (entry.userId) parts.push(`user=${entry.userId}`);
  if (entry.role) parts.push(`role=${entry.role}`);
  if (entry.orderId) parts.push(`orderId=${entry.orderId}`);
  if (entry.msgId) parts.push(`msgId=${entry.msgId}`);
  if (entry.error) parts.push(`error=${entry.error}`);
  console.log(`[${entry.tag}]${parts.length ? " " + parts.join(" ") : ""}`);
}

function safeAck(ack, payload) {
  if (typeof ack !== "function") return;
  try {
    ack(payload);
  } catch {
    // ignore ack errors
  }
}

/**
 * Initialize Socket.io server on existing HTTP server.
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: checkCorsOrigin,
      credentials: true,
    },
    allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers.origin)),
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token) {
        pushSocketLog("SOCKET_AUTH_FAIL", { error: "AUTH_FAILED" });
        return next(new Error("No token provided"));
      }

      if (!process.env.JWT_SECRET) {
        return next(new Error("Server configuration error"));
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = await tokenIdentity(decoded);
      next();
    } catch (err) {
      pushSocketLog("SOCKET_AUTH_FAIL", { error: "AUTH_FAILED" });
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", handleConnection);

  console.log("[Socket.io] Initialized");
  return io;
}

/**
 * Handle new socket connection.
 */
async function handleConnection(socket) {
  const userId = socket.user?.id;
  let userRole = socket.user.role;
  let isAdmin = userRole === "admin";
  // Long-lived connections also revalidate privileges after the handshake.
  socket.use(async (_packet, next) => {
    try {
      if (socket.user.exp && socket.user.exp * 1000 <= Date.now()) return socket.disconnect(true);
      if (isAdmin && !(await liveAdminIds([socket.user])).has(String(userId))) {
        leaveOrder();
        socket.leave("admin:orders");
        socket.join("order-chat:workers");
        userRole = socket.user.role = "user";
        isAdmin = false;
      }
      next();
    } catch {
      socket.disconnect(true);
    }
  });

  function leaveOrder() {
    if (socket.currentOrderRoom) {
      socket.leave(socket.currentOrderRoom);
      socket.leave(socket.currentOrderRoom + ":user:" + userId);
      socket.currentOrderRoom = null;
      socket.currentOrderId = null;
    }
  }

  async function permittedOrder(orderId, tag, ack) {
    try {
      const order = await Order.findById(orderId).select("userId status").lean();
      const error = orderChatDenial(order, userId, isAdmin);
      if (!error) return order;
      if (socket.currentOrderId === orderId) leaveOrder();
      pushSocketLog(tag, { userId, role: userRole, orderId, error });
      safeAck(ack, { ok: false, error });
    } catch {
      pushSocketLog(tag, { userId, role: userRole, orderId, error: "ORDER_UNAVAILABLE" });
      safeAck(ack, { ok: false, error: "ORDER_UNAVAILABLE" });
    }
    return null;
  }

  if (!isAdmin) socket.join("order-chat:workers");

  pushSocketLog("SOCKET_CONNECT_OK", { userId, role: userRole });

  // Admin global room (for inbox / notifications)
  socket.on("admin:join_orders", (data, ack) => {
    if (!socket.user?.id) {
      pushSocketLog("SOCKET_ADMIN_JOIN_FAIL", {
        userId,
        role: userRole,
        error: "AUTH_FAILED",
      });
      safeAck(ack, { ok: false, error: "AUTH_FAILED" });
      return;
    }

    if (!isAdmin) {
      pushSocketLog("SOCKET_ADMIN_JOIN_FAIL", {
        userId,
        role: userRole,
        error: "FORBIDDEN",
      });
      safeAck(ack, { ok: false, error: "FORBIDDEN" });
      return;
    }

    socket.join("admin:orders");
    pushSocketLog("SOCKET_ADMIN_JOIN_OK", { userId, role: userRole });
    safeAck(ack, { ok: true });
  });

  // Join order room
  socket.on("join:order", async (data, ack) => {
    const orderId = String(data?.orderId || "").trim();

    if (!socket.user?.id) {
      pushSocketLog("SOCKET_JOIN_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "AUTH_FAILED",
      });
      safeAck(ack, { ok: false, error: "AUTH_FAILED" });
      return;
    }

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      pushSocketLog("SOCKET_JOIN_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "INVALID_ORDER",
      });
      safeAck(ack, { ok: false, error: "INVALID_ORDER" });
      return;
    }

    if (!await permittedOrder(orderId, "SOCKET_JOIN_FAIL", ack)) return;

    const room = `order:${orderId}`;
    if (socket.currentOrderRoom !== room) leaveOrder();
    socket.join(room);
    if (!isAdmin) socket.join(room + ":user:" + userId);
    socket.currentOrderRoom = room;
    socket.currentOrderId = orderId;

    pushSocketLog("SOCKET_JOIN_OK", { userId, role: userRole, orderId });
    safeAck(ack, { ok: true });

    // Send existing messages
    const messages = await OrderMessage.find({ orderId })
      .sort({ createdAt: 1 })
      .lean();

    socket.emit("messages:history", {
      orderId,
      messages: messages.map(normalizeMessage),
    });
  });

  // Leave order room
  socket.on("leave:order", () => {
    if (socket.currentOrderRoom) {
      console.log(
        `[Socket.io] User ${userId} left room ${socket.currentOrderRoom}`,
      );
      leaveOrder();
    }
  });

  // Send message
  socket.on("message:send", async (data, ack) => {
    const tempId = data?.tempId; // Client-side temp ID for optimistic UI
    const orderId = String(data?.orderId || socket.currentOrderId || "").trim();
    const messageText = String(data?.text || data?.message || "").trim();

    if (!socket.user?.id) {
      pushSocketLog("SOCKET_SEND_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "AUTH_FAILED",
      });
      safeAck(ack, { ok: false, error: "AUTH_FAILED" });
      return;
    }

    if (!orderId) {
      pushSocketLog("SOCKET_SEND_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "INVALID_ORDER",
      });
      safeAck(ack, { ok: false, error: "INVALID_ORDER" });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      pushSocketLog("SOCKET_SEND_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "INVALID_ORDER",
      });
      safeAck(ack, { ok: false, error: "INVALID_ORDER" });
      return;
    }

    // Join must be completed before sending.
    if (String(socket.currentOrderId || "") !== String(orderId || "")) {
      pushSocketLog("SOCKET_SEND_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "NOT_JOINED",
      });
      safeAck(ack, { ok: false, error: "NOT_JOINED" });
      return;
    }

    const order = await permittedOrder(orderId, "SOCKET_SEND_FAIL", ack);
    if (!order) return;

    if (!messageText) {
      safeAck(ack, { ok: false, error: "MESSAGE_REQUIRED" });
      return;
    }

    if (messageText.length > 2000) {
      safeAck(ack, { ok: false, error: "MESSAGE_TOO_LONG" });
      return;
    }

    try {
      const senderRole = isAdmin ? "admin" : "user";

      // PATCH_91: Validate and include attachments from socket payload
      const attachments = Array.isArray(data?.attachments)
        ? data.attachments.filter(
            (att) =>
              att &&
              typeof att.url === "string" &&
              typeof att.filename === "string" &&
              typeof att.fileType === "string",
          )
        : [];

      const created = await OrderMessage.create({
        orderId,
        senderId: userId,
        userId: userId,
        senderRole,
        message: messageText,
        attachments,
        status: "sent",
        createdAt: new Date(),
      });

      const payload = normalizeMessage(created.toObject());
      // Include tempId for client reconciliation (helps avoid duplicates)
      if (tempId) payload.tempId = tempId;

      pushSocketLog("SOCKET_SEND_OK", {
        userId,
        role: userRole,
        orderId,
        msgId: String(created._id),
      });

      safeAck(ack, { ok: true, message: payload });

      try {
        await broadcastOrderMessage(order, payload);
      } catch (err) {
        console.warn("[CHAT_BROADCAST_FAIL]", err.name);
      }


    } catch (err) {
      pushSocketLog("SOCKET_SEND_FAIL", {
        userId,
        role: userRole,
        orderId,
        error: "SEND_FAILED",
      });
      safeAck(ack, { ok: false, error: "SEND_FAILED" });
      socket.emit("message:error", {
        tempId,
        error: "Failed to send message",
      });
    }
  });

  // Mark messages as delivered
  socket.on("message:delivered", async (data) => {
    const messageIds = Array.isArray(data?.messageIds) ? data.messageIds : [];
    const orderId = socket.currentOrderId;

    if (!orderId || messageIds.length === 0) return;

    try {
      if (!await permittedOrder(orderId, "SOCKET_RECEIPT_DENIED")) return;
      await OrderMessage.updateMany(
        {
          _id: { $in: messageIds },
          orderId,
          status: "sent",
        },
        { $set: { status: "delivered", deliveredAt: new Date() } },
      );

      const room = `order:${orderId}`;
      io.to(room).emit("message:status", {
        messageIds,
        status: "delivered",
      });
    } catch (err) {
      console.error("[Socket.io] message:delivered error:", err?.message);
    }
  });

  // Mark messages as seen
  socket.on("message:seen", async (data) => {
    const messageIds = Array.isArray(data?.messageIds) ? data.messageIds : [];
    const orderId = socket.currentOrderId;

    if (!orderId || messageIds.length === 0) return;

    try {
      if (!await permittedOrder(orderId, "SOCKET_RECEIPT_DENIED")) return;
      await OrderMessage.updateMany(
        {
          _id: { $in: messageIds },
          orderId,
          status: { $in: ["sent", "delivered"] },
        },
        { $set: { status: "seen", seenAt: new Date() } },
      );

      const room = `order:${orderId}`;
      io.to(room).emit("message:status", {
        messageIds,
        status: "seen",
      });
    } catch (err) {
      console.error("[Socket.io] message:seen error:", err?.message);
    }
  });

  // Typing indicator
  socket.on("typing:start", () => {
    const room = socket.currentOrderRoom;
    if (room) {
      socket.to(room).emit("typing:update", {
        userId,
        role: userRole,
        isTyping: true,
      });
    }
  });

  socket.on("typing:stop", () => {
    const room = socket.currentOrderRoom;
    if (room) {
      socket.to(room).emit("typing:update", {
        userId,
        role: userRole,
        isTyping: false,
      });
    }
  });

  // Disconnect
  socket.on("disconnect", (reason) => {
    pushSocketLog("SOCKET_DISCONNECT", {
      userId,
      role: userRole,
      error: reason,
    });
  });
}

/**
 * Normalize message for client.
 */
function normalizeMessage(msg) {
  return {
    _id: msg._id,
    id: msg._id,
    orderId: msg.orderId,
    senderId: msg.senderId,
    senderRole: msg.senderRole,
    message: msg.message,
    // PATCH_91: Include attachments in broadcast so both user and admin see them
    attachments: msg.attachments || [],
    status: msg.status || "sent",
    createdAt: msg.createdAt,
    deliveredAt: msg.deliveredAt || null,
    seenAt: msg.seenAt || null,
  };
}

/**
 * Get the Socket.io instance (for broadcasting from other parts of the app).
 */
function getIO() {
  return io;
}

async function broadcastOrderMessage(order, payload) {
  if (!io) return;
  const room = "order:" + order._id;
  const listeners = new Set(io.sockets.adapter.rooms.get(room) || []);
  if (payload.senderRole === "user") {
    for (const id of io.sockets.adapter.rooms.get("admin:orders") || []) listeners.add(id);
  }
  const sockets = [...listeners].map(id => io.sockets.sockets.get(id)).filter(Boolean);
  const admins = await liveAdminIds(sockets.map(socket => socket.user));
  for (const socket of sockets) {
    if (socket.user.exp && socket.user.exp * 1000 <= Date.now()) {
      socket.disconnect(true);
      continue;
    }
    const isAdmin = admins.has(String(socket.user.id));
    if (socket.rooms.has(room) && !orderChatDenial(order, socket.user.id, isAdmin)) socket.emit("message:new", payload);
    if (isAdmin && payload.senderRole === "user" && socket.rooms.has("admin:orders")) {
      socket.emit("admin:order_message", { orderId: String(order._id), message: payload });
    }
  }
}

/**
 * Broadcast a message to an order room from external code (e.g., REST endpoint).
 */
function broadcastToOrder(orderId, event, payload) {
  if (!io) return;
  const room = `order:${orderId}`;
  io.to(room).emit(event, payload);
}

function getSocketHealthSnapshot() {
  if (!io) {
    return {
      activeConnections: 0,
      rooms: [],
      logs: socketLogs.slice(-20),
    };
  }

  const rooms = [];
  const adapterRooms = io.sockets?.adapter?.rooms;
  if (adapterRooms && typeof adapterRooms.forEach === "function") {
    adapterRooms.forEach((sids, roomName) => {
      // Filter out per-socket rooms (roomName == socketId)
      if (io.sockets.sockets.has(roomName)) return;
      rooms.push({
        name: roomName,
        size: Array.isArray(sids) ? sids.length : sids?.size || 0,
      });
    });
  }

  rooms.sort((a, b) => b.size - a.size);

  return {
    activeConnections: io.engine?.clientsCount || 0,
    rooms,
    logs: socketLogs.slice(-20),
  };
}

module.exports = {
  initSocket,
  getIO,
  broadcastOrderMessage,
  broadcastToOrder,
  getSocketHealthSnapshot,
};
