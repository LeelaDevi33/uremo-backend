const express = require("express");
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const controller = require("../controllers/opportunity.controller");

const publicRoutes = express.Router();
const adminRoutes = express.Router();

function noCache(req, res, next) {
  res.set("Cache-Control", "private, no-store");
  next();
}
publicRoutes.use(noCache);
adminRoutes.use(noCache, auth, admin);

const optionalAuth = (req, res, next) => req.headers.authorization ? auth(req, res, next) : next();
publicRoutes.get("/", optionalAuth, controller.publicListings);
publicRoutes.get("/mine", auth, controller.mine);
publicRoutes.get("/:id/access", auth, controller.access);
publicRoutes.post("/:id/rent", auth, controller.checkout("rent"));
publicRoutes.post("/:id/buy", auth, controller.checkout("buy"));
publicRoutes.get("/:id", optionalAuth, controller.publicDetail);

adminRoutes.get("/", controller.adminListings);
adminRoutes.post("/", controller.saveListing);
adminRoutes.get("/:id", controller.adminDetail);
adminRoutes.patch("/:id", controller.saveListing);

function routeError(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error("[opportunities]", err.name, err.code);
  res.status(status).json({ ok: false, message: status >= 500 ? "Unable to complete the opportunity request" : err.message, ...err.fields });
}
publicRoutes.use(routeError);
adminRoutes.use(routeError);
module.exports = { publicRoutes, adminRoutes };
