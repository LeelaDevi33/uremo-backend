const Method = require("../models/WalletFundingMethod");
const WalletTransaction = require("../models/WalletTransaction");
const User = require("../models/User");
const { isWalletAmount } = require("../services/walletFunds");
const { gatewayStatus, paymentReference } = require("../services/walletFunding");
const Gateway = require("../models/WalletGatewaySetting");

async function listMethods(res, admin) {
  const [methods, paypal] = await Promise.all([
    Method.find(admin ? {} : { active: true }).sort({ name: 1, _id: 1 }).select("-__v").lean(),
    gatewayStatus(),
  ]);
  return res.json({ methods, paypal: admin ? paypal : { mode: paypal.mode, available: paypal.available } });
}

exports.workerMethods = (_req, res) => listMethods(res, false);
exports.adminMethods = (_req, res) => listMethods(res, true);
exports.setPayPalEnabled = async (req, res) => {
  const { enabled, updatedAt } = req.body;
  if (typeof enabled !== "boolean" || !(updatedAt === null || (typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt))))) {
    return res.status(400).json({ error: "The enabled state and last update time are required." });
  }
  if (enabled && !(await gatewayStatus()).configured) return res.status(409).json({ error: "Configure the PayPal account and webhook before enabling wallet funding." });
  const changes = { enabled, updatedBy: req.user.id };
  let saved;
  try {
    saved = updatedAt === null ? await Gateway.create({ _id: "paypal", ...changes }) :
      await Gateway.findOneAndUpdate({ _id: "paypal", updatedAt: new Date(updatedAt) }, { $set: changes }, { new: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  if (!saved) return res.status(409).json({ error: "The gateway setting changed. Reload it before saving." });
  return res.json({ paypal: await gatewayStatus() });
};

exports.saveMethod = async (req, res) => {
  const creating = !req.params.id;
  const changes = {};
  for (const [field, max] of Object.entries({ name: 80, details: 500, instructions: 1000 })) {
    const value = req.body[field];
    if (value === undefined && (!creating || field === "instructions")) continue;
    if (typeof value !== "string" || (field !== "instructions" && !value.trim()) || value.trim().length > max) {
      return res.status(400).json({ error: "Enter valid " + field + " (maximum " + max + " characters)." });
    }
    changes[field] = value.trim();
  }
  if (req.body.active !== undefined) {
    if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Active must be true or false." });
    changes.active = req.body.active;
  }
  if (creating) {
    const method = await Method.create(changes);
    return res.status(201).json({ method });
  }
  const updatedAt = new Date(req.body.updatedAt);
  if (!Method.base.isObjectIdOrHexString(req.params.id) || typeof req.body.updatedAt !== "string" || !Number.isFinite(updatedAt.valueOf()) || !Object.keys(changes).length) {
    return res.status(400).json({ error: "A valid method, changes and last update time are required." });
  }
  const method = await Method.findOneAndUpdate({ _id: req.params.id, updatedAt }, { $set: changes }, { new: true, runValidators: true });
  if (!method) return res.status(409).json({ error: "The method changed. Reload it before saving." });
  return res.json({ method });
};

exports.submitManual = async (req, res) => {
  const { methodId } = req.body;
  const amount = typeof req.body.amount === "string" ? Number(req.body.amount) : req.body.amount;
  if (!isWalletAmount(amount) || amount < 1) return res.status(400).json({ error: "Enter at least $1 USD with up to two decimal places." });
  if (!Method.base.isObjectIdOrHexString(methodId)) return res.status(400).json({ error: "Select an available funding method." });
  const reference = paymentReference(req.body.paymentReference);
  if (!reference) return res.status(400).json({ error: "Enter a valid payment reference (4–80 characters)." });
  const userId = req.user.id;
  const method = await Method.findOne({ _id: methodId, active: true }).lean();
  if (!method) return res.status(409).json({ error: "This funding method is no longer available." });
  const user = await User.findById(userId).select("walletBalance").lean();
  if (!user) return res.status(404).json({ error: "Wallet not found." });
  let tx;
  try {
    tx = await WalletTransaction.create({ user: userId, type: "credit", amount, source: "topup", status: "initiated",
      provider: "manual", methodId, methodName: method.name, paymentReference: reference,
      description: "Wallet top-up via " + method.name, balanceBefore: user.walletBalance || 0 });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return res.status(409).json({ error: "You already submitted this transfer for review." });
  }
  return res.json({ success: true, transactionId: tx._id, status: tx.status, amount, currentBalance: user.walletBalance || 0 });
};
