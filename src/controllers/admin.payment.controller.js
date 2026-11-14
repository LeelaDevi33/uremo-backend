const mongoose = require("mongoose");
const PaymentMethod = require("../models/PaymentMethod");

exports.retiredGateway = (_req, res) => res.status(410).json({
  message: "New marketplace payments use the wallet. Historical payment methods can only be disabled.",
});

exports.getPaymentMethodsAdmin = async (_req, res, next) => {
  try {
    const methods = await PaymentMethod.find().sort({ createdAt: -1 }).lean();
    res.set("Cache-Control", "private, no-store").json(methods);
  } catch (error) { next(error); }
};

exports.updatePaymentMethod = async (req, res, next) => {
  if (req.body?.active !== false || Object.keys(req.body).length !== 1) return exports.retiredGateway(req, res);
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(400).json({ message: "Invalid payment method." });
  try {
    const method = await PaymentMethod.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true });
    if (!method) return res.status(404).json({ message: "Payment method not found." });
    res.json(method);
  } catch (error) { next(error); }
};
