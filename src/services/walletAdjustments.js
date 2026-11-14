const User = require("../models/User");
const WalletTransaction = require("../models/WalletTransaction");
const { changeFunds, isWalletAmount } = require("./walletFunds");
const { logAdminAction } = require("./adminAudit.service");

const problem = (status, message) => Object.assign(new Error(message), { status });

async function record(actor, fields, funds, session) {
  const [receipt] = await WalletTransaction.create([{
    ...fields, source: "admin_adjustment", status: "success", provider: "manual", adjustmentOperator: actor.id,
    balanceBefore: funds.balanceBefore, balanceAfter: funds.walletBalance,
    withdrawablePortion: Number(Math.abs(funds.withdrawableBefore - funds.withdrawable).toFixed(2)),
  }], { session, ordered: true });
  await logAdminAction({
    adminId: actor.id, adminEmail: actor.email, action: fields.type === "credit" ? "wallet_credit" : "wallet_debit",
    entityType: "wallet", entityId: String(fields.user), reason: fields.description,
    previousState: { balance: funds.balanceBefore }, newState: { balance: funds.walletBalance },
    metadata: { transactionId: receipt.id, originalTransactionId: fields.referenceId, amount: fields.amount, type: fields.type },
  }, { session, required: true });
  return receipt;
}

function replay(receipt, fields) {
  if (String(receipt.user) !== String(fields.user) || receipt.type !== fields.type ||
      receipt.amount !== fields.amount || receipt.description !== fields.description) {
    throw problem(409, "This request ID was already used for another adjustment.");
  }
  return { receipt, replayed: true };
}

async function adjust(actor, body) {
  const { userId, type, requestId } = body || {};
  const amount = typeof body?.amount === "string" ? Number(body.amount) : body?.amount;
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!User.base.isObjectIdOrHexString(userId) || !["credit", "debit"].includes(type) || !isWalletAmount(amount)) {
    throw problem(400, "Choose a wallet, credit or debit, and a positive USD amount in whole cents.");
  }
  if (description.length < 5 || description.length > 500) throw problem(400, "Enter an adjustment reason between 5 and 500 characters.");
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw problem(400, "A unique adjustment request ID is required.");
  const key = { adjustmentOperator: actor.id, adjustmentKey: requestId };
  const fields = { user: userId, type, amount, description, adjustmentKey: requestId };
  try {
    return await User.db.transaction(async session => {
      const previous = await WalletTransaction.findOne(key).session(session);
      if (previous) return replay(previous, fields);
      const funds = await changeFunds(userId, amount, type === "credit" ? "credit" : "spend", session);
      return { receipt: await record(actor, fields, funds, session), replayed: false };
    });
  } catch (err) {
    if (err.code !== 11000 || !err.keyPattern?.adjustmentKey) throw err;
    const prior = await WalletTransaction.findOne(key);
    if (!prior) throw err;
    return replay(prior, fields);
  }
}

async function undo(actor, id) {
  if (!User.base.isObjectIdOrHexString(id)) throw problem(400, "Invalid adjustment receipt.");
  return User.db.transaction(async session => {
    const original = await WalletTransaction.findOne({ _id: id, source: "admin_adjustment", status: "success",
      adjustmentKey: { $type: "string" } }).session(session);
    if (!original) throw problem(404, "No reversible adjustment receipt was found.");
    if (original.undoTransactionId) {
      const receipt = await WalletTransaction.findById(original.undoTransactionId).session(session);
      if (!receipt) throw problem(409, "The original reversal requires reconciliation.");
      return { receipt, replayed: true };
    }
    const restoring = original.type === "debit";
    const funds = await changeFunds(original.user, original.amount, restoring ? "refund" : "spend", session,
      { withdrawableRefund: original.withdrawablePortion });
    if (!restoring && funds.withdrawable < funds.withdrawableBefore) {
      throw problem(409, "The credited funds are no longer available to reverse without using earnings.");
    }
    const receipt = await record(actor, { user: original.user, type: restoring ? "credit" : "debit",
      amount: original.amount, description: "Undo: " + original.description, referenceId: original._id }, funds, session);
    original.undoTransactionId = receipt._id;
    await original.save({ session });
    return { receipt, replayed: false };
  });
}

module.exports = { adjust, undo };
