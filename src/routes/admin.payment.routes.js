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

router.post("/", retiredGateway);
router.get("/", getPaymentMethodsAdmin);
router.put("/:id", updatePaymentMethod);
router.delete("/:id", retiredGateway);

module.exports = router;
