const express = require("express");
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");

const {
  retiredGateway,
  getPaymentMethodsAdmin,
  updatePaymentMethod,
} = require("../controllers/admin.payment.controller");

const router = express.Router();
router.use(auth, admin);
const funding = require("../controllers/walletFunding.controller");
router.get("/funding", funding.adminMethods);
router.post("/funding", funding.saveMethod);
router.patch("/funding/paypal", funding.setPayPalEnabled);
router.patch("/funding/:id", funding.saveMethod);

router.post("/", retiredGateway);
router.get("/", getPaymentMethodsAdmin);
router.put("/:id", updatePaymentMethod);
router.delete("/:id", retiredGateway);

module.exports = router;
