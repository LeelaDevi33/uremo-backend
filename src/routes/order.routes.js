const express = require("express");
const retiredCatalog = require("../middlewares/retiredCatalog");
const auth = require("../middlewares/auth.middleware");
const {
  myOrders,
  getOrderById,
  submitPayment,
} = require("../controllers/order.controller");
const {
  getOrderMessages,
  postOrderMessage,
  streamOrderMessages,
} = require("../controllers/orderMessage.controller");

const router = express.Router();

router.post("/", auth, retiredCatalog);
router.get("/", auth, myOrders); // Alias for /my
router.get("/my", auth, myOrders);
// PATCH_38: Deal order creation
router.post("/deal", auth, retiredCatalog);
router.get("/:id/messages", auth, getOrderMessages);
router.post("/:id/messages", auth, postOrderMessage);
router.get("/:id/messages/stream", auth, streamOrderMessages);
router.get("/:id", auth, getOrderById);
router.put("/:id/payment", auth, submitPayment);

module.exports = router;
