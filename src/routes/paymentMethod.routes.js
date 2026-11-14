const express = require("express");
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const { getActive } = require("../controllers/paymentMethod.controller");
const { getPaymentMethodsAdmin, retiredGateway, updatePaymentMethod } = require("../controllers/admin.payment.controller");

const router = express.Router();

// Admin routes
router.get("/admin", auth, admin, getPaymentMethodsAdmin);
router.post("/admin", auth, admin, retiredGateway);
router.put("/admin/:id", auth, admin, updatePaymentMethod);

// Public route
router.get("/", getActive);

module.exports = router;
