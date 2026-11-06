const express = require("express");
const mongoose = require("mongoose");

const authOptional = require("../middlewares/authOptional.middleware");
const Service = require("../models/Service");

const router = express.Router();

// Simple health check - no auth required
router.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness includes a bounded database round-trip so a live process cannot
// receive traffic while its database is unavailable.
router.get("/ready", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const connection = mongoose.connection;
  if (connection.readyState === 1 && connection.db) {
    try {
      await connection.db.command({ ping: 1 }, { timeoutMS: 1500 });
      return res.json({ status: "ready" });
    } catch {
      // Keep driver errors and connection details out of the public response.
    }
  }
  return res.status(503).json({ status: "unavailable" });
});

function hasDebugAccess(req) {
  // In production, require either:
  // - a matching header token, or
  // - an admin JWT (role embedded in token)
  const inProd =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!inProd) return true;

  const headerToken = req.headers["x-health-token"];
  const expected = String(process.env.HEALTH_DEBUG_TOKEN || "").trim();
  if (expected && headerToken && String(headerToken) === expected) return true;

  return req.user?.role === "admin";
}

// STEP 1 (TRIAGE): System health snapshot
// NOTE: Protected in production via x-health-token or admin JWT.
router.get("/services", authOptional, async (req, res) => {
  if (!hasDebugAccess(req)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const dbOk = mongoose?.connection?.readyState === 1;

  let total = 0;
  let active = 0;
  try {
    total = await Service.countDocuments({});
    active = await Service.countDocuments({ active: true });
  } catch (err) {
    // If DB is down, keep counts as 0 and report dbOk=false.
    console.error("[HEALTH_SERVICES_COUNT_FAIL]", err?.message);
  }

  const authenticated = !!req.user?.id;
  const isAdmin = req.user?.role === "admin";

  if (process.env.DEBUG_REQUESTS === "1") {
    console.log("[HEALTH_SERVICES]", {
      authenticated,
      isAdmin,
      total,
      active,
      dbOk,
      ip: req.ip,
    });
  }

  return res.json({
    authenticated,
    admin: isAdmin,
    services: {
      total,
      active,
      public: active,
    },
    dbOk,
    serverTime: new Date().toISOString(),
  });
});

module.exports = router;
