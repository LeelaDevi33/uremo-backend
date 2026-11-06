const User = require("../models/User");

const toCents = amount => Math.round(amount * 100);
function isWalletAmount(amount) {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 &&
    Number.isSafeInteger(toCents(amount)) && Number(amount.toFixed(2)) === amount;
}
function walletError(status, message, fields) {
  return Object.assign(new Error(message), { status, fields });
}
function availableFunds(user) {
  const total = toCents(user.walletBalance || 0);
  const reserved = toCents(user.pendingWithdrawals || 0);
  const spendable = Math.max(0, total - reserved);
  const eligible = Math.max(0, Math.min(toCents(user.withdrawable || 0), spendable));
  return { spendable: spendable / 100, withdrawable: eligible / 100 };
}

// All callers use the same user document in their ledger/receipt transaction.
// A competing wallet mutation produces a write conflict and retries the whole operation.
async function changeFunds(userId, amount, action, session) {
  if (!session?.inTransaction()) throw new Error("A wallet transaction is required");
  if (!isWalletAmount(amount)) throw walletError(400, "Enter a positive USD amount with at most two decimals");
  const user = await User.findById(userId).select("walletBalance withdrawable pendingWithdrawals lifetimeEarnings").session(session).lean();
  if (!user) throw walletError(404, "Wallet not found");
  let total = toCents(user.walletBalance || 0);
  let reserved = toCents(user.pendingWithdrawals || 0);
  const before = total / 100;
  const funds = availableFunds(user);
  let eligible = toCents(funds.withdrawable);
  const value = toCents(amount);
  if (action === "spend") {
    if (value > total - reserved) throw walletError(402, "Insufficient spendable wallet balance", { required: amount, available: funds.spendable });
    total -= value;
    // Spend top-ups and other non-withdrawable dollars first.
    eligible = Math.min(eligible, total - reserved);
  } else if (action === "reserve") {
    if (value > eligible) throw walletError(400, "Insufficient withdrawable balance", { requested: amount, available: funds.withdrawable });
    eligible -= value;
    reserved += value;
  } else if (action === "release" || action === "payout") {
    if (reserved < value || (action === "payout" && reserved > total)) {
      throw walletError(409, "Withdrawal reservation requires reconciliation");
    }
    reserved -= value;
    if (action === "payout") total -= value;
    else eligible = Math.max(0, Math.min(eligible + value, total - reserved));
  } else if (action === "credit" || action === "earning") {
    total += value;
    if (action === "earning") eligible = Math.min(eligible + value, Math.max(0, total - reserved));
  } else {
    throw new Error("Unknown wallet operation");
  }
  if (![total, reserved, eligible].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw walletError(409, "Wallet balance requires reconciliation");
  }
  const update = { walletBalance: total / 100, withdrawable: eligible / 100, pendingWithdrawals: reserved / 100 };
  if (action === "earning") {
    const lifetime = toCents(user.lifetimeEarnings || 0) + value;
    if (!Number.isSafeInteger(lifetime) || lifetime < 0) throw walletError(409, "Lifetime earnings require reconciliation");
    update.lifetimeEarnings = lifetime / 100;
  }
  await User.updateOne({ _id: userId }, { $set: { ...update, lastWalletUpdate: new Date() } }, { session });
  return { ...update, balanceBefore: before };
}
module.exports = { availableFunds, changeFunds, isWalletAmount };
