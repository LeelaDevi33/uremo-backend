// Express app configuration
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const { checkCorsOrigin } = require("./config/browserOrigins");

// PATCH_31: Load FlowEngine hooks (side-effect module)
require("./core/flowHooks");

const app = express();

// Routes
const authRoutes = require("./routes/auth.routes");
const serviceRoutes = require("./routes/service.routes");
const orderRoutes = require("./routes/order.routes");
const uploadRoutes = require("./routes/upload.routes");
const adminRoutes = require("./routes/admin.routes");
const paymentRoutes = require("./routes/payment.routes");
const paymentMethodRoutes = require("./routes/paymentMethod.routes");
const workerRoutes = require("./routes/worker.routes");
const applyWorkRoutes = require("./routes/applyWork.routes");
const workPositionRoutes = require("./routes/workPosition.routes");
const adminWorkPositionRoutes = require("./routes/admin.workPosition.routes");
const adminPaymentRoutes = require("./routes/admin.payment.routes");
const adminServiceRequestRoutes = require("./routes/admin.serviceRequest.routes");
const cronRoutes = require("./routes/cron.routes");
const settingsRoutes = require("./routes/settings.routes");
const jarvisxRoutes = require("./routes/jarvisx.routes");
const jarvisxWriteRoutes = require("./routes/jarvisx.write.routes");
const serviceRequestRoutes = require("./routes/serviceRequest.routes");
const healthRoutes = require("./routes/health.routes");
const debugRoutes = require("./routes/debug.routes");
const adminServicesRoutes = require("./routes/adminServices");
// PATCH_21: Blog routes
const blogsRoutes = require("./routes/blogs.routes");
const adminBlogsRoutes = require("./routes/admin.blogs.routes");
// PATCH_22: Rental routes
const rentalsRoutes = require("./routes/rentals.routes");
const adminRentalsRoutes = require("./routes/admin.rentals.routes");
// PATCH_23: Affiliate routes
const affiliateRoutes = require("./routes/affiliate.routes");
const adminAffiliateRoutes = require("./routes/admin.affiliate.routes");
// PATCH_23: Wallet routes
const walletRoutes = require("./routes/wallet.routes");
const adminWalletRoutes = require("./routes/admin.wallet.routes");
// PATCH_24: Support Ticket routes
const ticketsRoutes = require("./routes/tickets.routes");
const adminTicketsRoutes = require("./routes/admin.tickets.routes");
// PATCH_29: Notification routes
const notificationRoutes = require("./routes/notification.routes");
// PATCH_30: Admin Analytics routes
const adminAnalyticsRoutes = require("./routes/adminAnalytics.routes");
// PATCH_38: Workspace routes (worker flow)
const workspaceRoutes = require("./routes/workspace.routes");
const adminWorkspaceRoutes = require("./routes/admin.workspace.routes");
// PATCH_43: Admin Job Role routes
const adminJobRoleRoutes = require("./routes/admin.jobRole.routes");
// PATCH_41: FAQ and Public routes
const faqRoutes = require("./routes/faq.routes");
const publicRoutes = require("./routes/public.routes");
// PATCH_95: Admin Dataset & RLHF routes
const adminDatasetRoutes = require("./routes/admin.dataset.routes");

const auth = require("./middlewares/auth.middleware");
const admin = require("./middlewares/admin.middleware");

const Order = require("./models/Order");
const OrderMessage = require("./models/OrderMessage");

const corsOptions = {
  origin: checkCorsOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // NOTE: Browsers may include Cache-Control/Pragma in preflight (e.g., Next.js fetch defaults).
  // If they're missing here, the preflight fails with:
  // "Request header field cache-control is not allowed by Access-Control-Allow-Headers".
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-admin-setup-secret",
    "Cache-Control",
    "Pragma",
  ],
};

app.use(cors(corsOptions));
// Preflight MUST return correctly.
// Express 5 does not support "*" here (path-to-regexp). Use a regex that matches all.
app.options(/.*/, cors(corsOptions));
// P0 FIX: Parse cookies for stable session ID (jarvisx_sid)
app.use(cookieParser());
// Allow up to ~250KB JSON bodies so CMS raw JSON import can work, while
// still enforcing a stricter per-endpoint max size in controllers.
app.use(express.json({ limit: "250kb" }));
// Accept legacy form submissions (or older frontend builds) where Content-Type is urlencoded.
app.use(express.urlencoded({ extended: true }));

// Handle invalid JSON bodies gracefully (body-parser SyntaxError)
app.use((err, req, res, next) => {
  if (
    err &&
    err instanceof SyntaxError &&
    err.status === 400 &&
    "body" in err
  ) {
    return res.status(400).json({
      message: "Invalid JSON",
      details: err.message,
    });
  }
  return next(err);
});

app.get("/", (req, res) => {
  res.json({ message: "UREMO API running" });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live" });
});

// Debug endpoint for chat health (admin-only)
app.get("/api/debug/chat-health", auth, admin, async (req, res) => {
  const orderId = String(req.query.orderId || "").trim();

  if (!orderId) {
    return res.status(400).json({ message: "orderId query param required" });
  }

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.json({
      orderExists: false,
      totalMessagesCount: 0,
      latestMessageSnippet: null,
      serverTime: new Date().toISOString(),
    });
  }

  try {
    const order = await Order.findById(orderId).lean();
    const totalMessagesCount = await OrderMessage.countDocuments({ orderId });
    const latestMessage = await OrderMessage.findOne({ orderId })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      orderExists: !!order,
      totalMessagesCount,
      latestMessageSnippet: latestMessage?.message
        ? String(latestMessage.message).slice(0, 80)
        : null,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `[DEBUG_CHAT_HEALTH_FAIL] orderId=${orderId} errMessage=${err?.message}`,
    );
    return res.status(500).json({ message: "Debug endpoint error" });
  }
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/payments", adminPaymentRoutes);
app.use("/api/admin/service-requests", adminServiceRequestRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/payment-methods", paymentMethodRoutes);
app.use("/api/workers", workerRoutes);
app.use("/api/apply-work", applyWorkRoutes);
app.use("/api/work-positions", workPositionRoutes);
app.use("/api/admin/work-positions", adminWorkPositionRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/jarvisx", jarvisxRoutes);
app.use("/api/jarvisx/write", jarvisxWriteRoutes);
app.use("/api/service-requests", serviceRequestRoutes);
app.use("/api/admin", adminServicesRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/debug", debugRoutes);
// PATCH_21: Blog routes
app.use("/api/blogs", blogsRoutes);
app.use("/api/admin/blogs", auth, admin, adminBlogsRoutes);
// PATCH_22: Rental routes
app.use("/api/rentals", rentalsRoutes);
app.use("/api/admin/rentals", adminRentalsRoutes);
// PATCH_23: Affiliate routes
app.use("/api/affiliate", affiliateRoutes);
app.use("/api/admin/affiliate", adminAffiliateRoutes);
// PATCH_23: Wallet routes
app.use("/api/wallet", walletRoutes);
app.use("/api/admin/wallet", adminWalletRoutes);
// PATCH_24: Support Ticket routes
app.use("/api/tickets", ticketsRoutes);
app.use("/api/admin/tickets", adminTicketsRoutes);
// PATCH_29: Notification routes
app.use("/api/notifications", notificationRoutes);
// PATCH_30: Admin Analytics routes
app.use("/api/admin/analytics", adminAnalyticsRoutes);
// PATCH_38: Workspace routes (worker flow)
app.use("/api/workspace", workspaceRoutes);
app.use("/api/admin/workspace", adminWorkspaceRoutes);
// PATCH_43: Admin Job Role routes
app.use("/api/admin/workspace", adminJobRoleRoutes);
// PATCH_48: Admin Proofs routes
const adminProofRoutes = require("./routes/admin.proof.routes");
app.use("/api/admin/proofs", adminProofRoutes);
// PATCH_49: Public Proofs routes
const proofRoutes = require("./routes/proof.routes");
app.use("/api/proofs", proofRoutes);
// PATCH_41: FAQ and Public routes
app.use("/api/faqs", faqRoutes);
app.use("/api/public", publicRoutes);
// PATCH_95: Admin Dataset & RLHF routes
app.use("/api/admin/datasets", adminDatasetRoutes);
// PATCH_53: User preferences and admin campaigns routes
const userPreferencesRoutes = require("./routes/user.preferences.routes");
const adminCampaignRoutes = require("./routes/admin.campaign.routes");
app.use("/api/users", userPreferencesRoutes);
app.use("/api/admin/campaigns", auth, admin, adminCampaignRoutes);

// PATCH_58: Smart Engagement Engine routes
const engagementRoutes = require("./routes/engagement.routes");
app.use("/api/engagement", engagementRoutes);

// TEMP: Debug endpoint to list mounted routes (admin-only)
app.get("/api/__routes", auth, admin, (req, res) => {
  const routes = new Set();

  const stack =
    (app._router && app._router.stack) ||
    (app.router && app.router.stack) ||
    [];

  const cleanPrefix = (prefix) => {
    if (!prefix) return "";
    if (prefix === "/") return "";
    return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  };

  const joinPaths = (a, b) => {
    const left = cleanPrefix(a);

    // normalize b into a string always
    const raw = b == null ? "" : Array.isArray(b) ? b[0] : String(b);

    if (!raw || raw === "/") return left || "/";

    const right = raw.startsWith("/") ? raw : `/${raw}`;
    const out = `${left}${right}`;
    return out || "/";
  };
  const getLayerMountPath = (layer) => {
    if (!layer || !layer.regexp) return "";
    if (layer.regexp.fast_slash) return "";

    let src = layer.regexp.source || "";
    if (!src || src === "^\\/?$" || src === "^$") return "";

    // Best-effort conversion of express layer regex to a human-readable mount path.
    // Common router mounts look like: ^\/api\/auth\/?(?=\/|$)
    if (src.startsWith("^")) src = src.slice(1);
    if (src.endsWith("$")) src = src.slice(0, -1);
    src = src.replaceAll("\\/?(?=\\/|$)", "");
    src = src.replaceAll("\\/", "/");
    src = src.replaceAll("(?:", "(");

    // Replace common param-ish groups with a token.
    src = src
      .replace(/\(\[\^\/\]\+\?\)/g, ":param")
      .replace(/\(\[\^\/\]\+\)/g, ":param");

    // Cleanup.
    src = src.replace(/\$/g, "");
    src = src.replace(/\^/g, "");
    if (src.endsWith("/")) src = src.slice(0, -1);
    return src;
  };

  const recordRoute = (methods, path) => {
    const methodStr = (methods || []).join(",").toUpperCase();
    routes.add(`${methodStr} ${path}`);
  };

  const walk = (layers, prefix = "") => {
    if (!Array.isArray(layers)) return;
    layers.forEach((layer) => {
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {});
        const routePath = joinPaths(prefix, layer.route.path);
        recordRoute(methods, routePath);
        return;
      }

      // Mounted router
      if (layer.name === "router" && layer.handle && layer.handle.stack) {
        const mount = getLayerMountPath(layer);
        const nextPrefix = joinPaths(prefix, mount);
        walk(layer.handle.stack, nextPrefix);
      }
    });
  };

  walk(stack, "");

  const list = Array.from(routes).sort();
  res.json({ count: list.length, routes: list });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ message: err.message || "Server error" });
});

module.exports = app;
