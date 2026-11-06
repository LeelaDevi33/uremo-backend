const express = require("express");
const retiredCatalog = require("../middlewares/retiredCatalog");
const auth = require("../middlewares/auth.middleware");
const {
  getActivePaymentMethods,
} = require("../controllers/payment.controller");

const router = express.Router();

router.get("/", getActivePaymentMethods);
router.post("/checkout", auth, retiredCatalog);

module.exports = router;
