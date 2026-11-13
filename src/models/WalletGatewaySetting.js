const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: { type: String, enum: ["paypal"] },
  enabled: { type: Boolean, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

module.exports = mongoose.model("WalletGatewaySetting", schema);
