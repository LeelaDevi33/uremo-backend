const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  details: { type: String, required: true, trim: true, maxlength: 500 },
  instructions: { type: String, trim: true, maxlength: 1000, default: "" },
  active: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("WalletFundingMethod", schema);
