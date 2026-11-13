const Gateway = require("../models/WalletGatewaySetting");
const paypal = require("../config/paypal");

function paymentReference(value) {
  const reference = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9][A-Z0-9._/-]{3,79}$/.test(reference) ? reference : "";
}

async function gatewayStatus() {
  const { configured, mode, webhookConfigured } = paypal.status();
  const setting = await Gateway.findById("paypal").lean();
  const enabled = setting?.enabled === true;
  return { configured, mode, webhookConfigured, enabled, available: configured && enabled, updatedAt: setting?.updatedAt ?? null };
}

module.exports = { paymentReference, gatewayStatus };
