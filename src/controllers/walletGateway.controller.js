const WalletTransaction = require("../models/WalletTransaction");
const User = require("../models/User");
const { isWalletAmount, changeFunds } = require("../services/walletFunds");
const paypal = require("../config/paypal");
const { getFrontendUrl } = require("../config/frontendUrl");
const { gatewayStatus } = require("../services/walletFunding");

const error = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === "string" && /^[A-Z0-9]{1,36}$/.test(value);

function ensureConfigured() {
  if (!paypal.status().configured) throw error(503, "PayPal wallet funding is not configured.");
}

function handler(action) {
  return async (req, res) => {
    try {
      ensureConfigured();
      res.json(await action(req));
    } catch (err) {
      if (!err.status) console.error("PayPal wallet operation failed:", err.name, err.providerStatus || err.code || "");
      res.status(err.status || 503).json({ error: err.status ? err.message : "Could not verify the payment. Please retry." });
    }
  };
}

exports.available = async (_req, res) => {
  const { available, mode } = await gatewayStatus();
  res.json({ success: true, available, mode });
};
exports.create = handler(async req => {
  if (!(await gatewayStatus()).available) throw error(503, "PayPal wallet funding is paused.");
  const amount = typeof req.body.amount === "string" ? Number(req.body.amount) : req.body.amount;
  if (!isWalletAmount(amount) || amount < 1) throw error(400, "Enter at least $1 USD with up to two decimal places.");
  const user = await User.findById(req.user.id).select("walletBalance").lean();
  if (!user) throw error(404, "Wallet not found.");
  const token = await paypal.authorize();
  const tx = await WalletTransaction.create({ user: user._id, type: "credit", source: "topup", amount, status: "initiated",
    provider: "paypal", gatewayMode: paypal.status().mode, description: "Wallet top-up via PayPal", balanceBefore: user.walletBalance || 0 });
  try {
    const frontend = new URL("/wallet", getFrontendUrl()).href;
    const order = await paypal.create(token, { intent: "CAPTURE", purchase_units: [{ custom_id: String(tx._id),
      payee: { merchant_id: process.env.PAYPAL_MERCHANT_ID }, amount: { currency_code: "USD", value: amount.toFixed(2) } }],
      payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: frontend + "?paypal=success",
        cancel_url: frontend + "?paypal=cancelled" } } } }, "create-" + tx._id);
    const link = order.links?.find(link => ["payer-action", "approve"].includes(link.rel) && paypal.validApprovalURL(link.href));
    if (!validId(order.id) || !link) throw error(502, "PayPal did not return a valid checkout link.");
    await WalletTransaction.updateOne({ _id: tx._id }, { $set: { providerRef: order.id } });
    return { success: true, transactionId: tx._id, paypalOrderId: order.id, approvalUrl: link.href, status: "initiated", amount };
  } catch (err) {
    // No approval URL reached the caller. A later verified capture can still settle this row.
    await WalletTransaction.updateOne({ _id: tx._id, status: "initiated", providerRef: null },
      { $set: { status: "failed", failureReason: "PayPal checkout could not be opened." } });
    throw err;
  }
});

function validateOrder(order, tx, orderId) {
  const unit = order.purchase_units?.[0];
  if (order.id !== orderId || order.intent !== "CAPTURE" || order.purchase_units?.length !== 1 ||
      unit?.payee?.merchant_id !== process.env.PAYPAL_MERCHANT_ID ||
      (tx.gatewayMode && (tx.gatewayMode !== paypal.status().mode || unit.custom_id !== String(tx._id))) ||
      (unit.custom_id && unit.custom_id !== String(tx._id)) || !matchesAmount(unit.amount, tx.amount)) {
    throw error(409, "PayPal order details do not match the wallet request.");
  }
  return unit;
}
function matchesAmount(money, amount) {
  return money?.currency_code === "USD" && /^\d+(\.\d{1,2})?$/.test(money.value) && Number(money.value) === amount;
}
async function finalize(tx, orderId, token, order) {
  if (tx.status === "success") return { success: true, transactionId: tx._id, status: tx.status, balance: tx.balanceAfter, alreadyProcessed: true };
  order ||= await paypal.read(token, orderId);
  validateOrder(order, tx, orderId);
  if (order.status === "APPROVED") {
    try { await paypal.capture(token, orderId, "capture-" + tx._id); }
    catch (err) { if (err.providerStatus !== 422) throw err; }
    // The full order includes payee, purchase-unit binding and the final capture.
    order = await paypal.read(token, orderId);
  }
  const unit = validateOrder(order, tx, orderId);
  const captures = unit.payments?.captures;
  if (order.status !== "COMPLETED" || captures?.length !== 1 || captures[0].status !== "COMPLETED") {
    throw error(409, "PayPal has not confirmed a completed payment.");
  }
  const capture = captures[0];
  if (!validId(capture.id) || !matchesAmount(capture.amount, tx.amount) || capture.final_capture === false) {
    throw error(409, "PayPal capture details do not match the wallet request.");
  }
  return User.db.transaction(async session => {
    const current = await WalletTransaction.findById(tx._id).session(session);
    if (!current || current.provider !== "paypal" || current.amount !== tx.amount || (current.providerRef && current.providerRef !== orderId)) {
      throw error(409, "Wallet payment details changed.");
    }
    if (current.status === "success") return { success: true, transactionId: current._id, status: "success", balance: current.balanceAfter, alreadyProcessed: true };
    // A completed provider capture takes precedence over a locally cancelled legacy request.
    const funds = await changeFunds(current.user, current.amount, "credit", session);
    current.set({ status: "success", providerRef: orderId, settlementReference: "PAYPAL:" + capture.id,
      balanceBefore: funds.balanceBefore, balanceAfter: funds.walletBalance, description: "Wallet top-up verified by PayPal", failureReason: null });
    await current.save({ session });
    return { success: true, transactionId: current._id, status: "success", balance: funds.walletBalance };
  });
}

exports.confirm = handler(async req => {
  const id = req.body.paypalOrderId;
  if (!validId(id)) throw error(400, "Enter a valid PayPal order ID.");
  const tx = await WalletTransaction.findOne({ user: req.user.id, provider: "paypal", source: "topup", providerRef: id });
  if (!tx) throw error(404, "Wallet payment not found.");
  return finalize(tx, id, tx.status === "success" ? null : await paypal.authorize());
});

exports.webhook = handler(async req => {
  const event = req.body;
  const token = await paypal.authorize();
  if (!await paypal.verify(token, req.headers, event)) throw error(401, "Invalid PayPal webhook signature.");
  let orderId;
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") orderId = event.resource?.id;
  else if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  else return { received: true };
  if (!validId(orderId)) throw error(400, "A valid PayPal order ID is required.");
  let tx = await WalletTransaction.findOne({ provider: "paypal", source: "topup", providerRef: orderId });
  let order;
  if (!tx) {
    // Recover a provider order created before its ID was written locally.
    order = await paypal.read(token, orderId);
    const customId = order.purchase_units?.[0]?.custom_id;
    if (WalletTransaction.base.isObjectIdOrHexString(customId)) {
      tx = await WalletTransaction.findOne({ _id: customId, provider: "paypal", source: "topup", providerRef: null, gatewayMode: paypal.status().mode });
    }
  }
  if (tx) await finalize(tx, orderId, token, order);
  return { received: true };
});
