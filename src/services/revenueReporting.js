const Grant = require("../models/OpportunityGrant");
const Order = require("../models/Order");
const WalletTransaction = require("../models/WalletTransaction");

// A grant is the purchase receipt written in the same transaction as its wallet debit.
async function projectRevenue() {
  const rows = await Grant.aggregate([
    { $match: { type: { $in: ["rent", "buy"] }, currency: "USD", refundedAt: null } },
    { $group: {
      _id: "$type", count: { $sum: 1 },
      cents: { $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] } },
    } },
  ]);
  const totals = { currency: "USD", rent: { count: 0, total: 0 }, buy: { count: 0, total: 0 } };
  for (const row of rows) totals[row._id] = { count: row.count, total: row.cents / 100 };
  return totals;
}

// Legacy orders may predate the settlement snapshot. One actual USD wallet debit
// for the same order and buyer is evidence of payment even on an older record.
// Work status and the service's current asking price cannot establish a receipt.
function legacyPayments() {
  return [
    // Combine both sets once. Looking up each order by the ledger's unindexed
    // referenceId would rescan the full wallet collection for every order.
    { $project: {
      orderId: "$_id", owner: "$userId",
      order: { status: "$status", paymentStatus: "$paymentStatus", paidAt: "$paidAt",
        settledAmount: "$settledAmount", settledCurrency: "$settledCurrency", quotedCurrency: "$quotedCurrency" },
    } },
    { $unionWith: { coll: WalletTransaction.collection.name, pipeline: [
      { $match: { type: "debit", status: "success", referenceId: { $type: "objectId" },
        source: { $in: ["service_purchase", "rental_purchase", "rental_payment"] } } },
      { $project: { orderId: "$referenceId", owner: "$user", debit: { amount: "$amount", at: "$createdAt", currency: "$currency" } } },
    ] } },
    { $group: { _id: { id: "$orderId", user: "$owner" }, order: { $max: "$order" },
      debit: { $max: "$debit" }, debitCount: { $sum: { $cond: [{ $eq: [{ $type: "$debit" }, "object"] }, 1, 0] } } } },
    { $match: { "order": { $type: "object" } } },
    { $replaceWith: { $mergeObjects: ["$order", { debit: "$debit", debitCount: "$debitCount" }] } },
    { $set: {
      hasSnapshot: { $and: [
        { $in: ["$paymentStatus", ["paid", "refunded"]] }, { $isNumber: "$settledAmount" }, { $gt: ["$settledAmount", 0] },
        { $regexMatch: { input: { $ifNull: ["$settledCurrency", ""] }, regex: "^[A-Z]{3}$" } },
      ] },
    } },
    { $set: {
      hasWalletEvidence: { $and: [
        { $eq: ["$debitCount", 1] }, { $isNumber: "$debit.amount" }, { $gt: ["$debit.amount", 0] },
        // The previous checkout could debit a service price without recording
        // its currency. An unqualified historical number is not proof of USD.
        { $eq: [{ $ifNull: ["$debit.currency", "$settledCurrency", "$quotedCurrency", null] }, "USD"] },
        { $eq: [{ $ifNull: ["$settledCurrency", "USD"] }, "USD"] },
      ] },
    } },
    { $match: { $or: [
      { hasSnapshot: true }, { hasWalletEvidence: true }, { paymentStatus: { $in: ["paid", "refunded"] } },
      { paidAt: { $type: "date" } }, { status: { $in: ["in_progress", "waiting_user", "completed"] } },
      { debitCount: { $gt: 0 } },
    ] } },
    { $project: {
      amount: { $cond: ["$hasSnapshot", "$settledAmount", { $cond: ["$hasWalletEvidence", "$debit.amount", null] }] },
      currency: { $cond: ["$hasSnapshot", "$settledCurrency", { $cond: ["$hasWalletEvidence", "USD", null] }] },
      settledAt: { $ifNull: ["$paidAt", "$debit.at"] },
    } },
  ];
}

async function legacyRevenue(startDate) {
  const stages = legacyPayments();
  if (startDate) {
    stages.push({ $match: { currency: "USD", settledAt: { $gte: startDate } } });
  }
  const key = startDate ? { $dateToString: { format: "%Y-%m-%d", date: "$settledAt" } } : "$currency";
  return Order.aggregate([...stages,
    { $group: { _id: key, count: { $sum: 1 }, sum: { $sum: { $toDecimal: "$amount" } } } },
    { $project: { count: 1, total: { $toDouble: "$sum" } } }, { $sort: { _id: 1 } },
  ]).allowDiskUse(true);
}

async function walletFunding() {
  const [result] = await WalletTransaction.aggregate([
    { $match: { type: "credit", status: "success" } },
    { $group: {
      _id: null, credits: { $sum: { $toDecimal: "$amount" } },
      deposits: { $sum: { $cond: [{ $eq: ["$source", "topup"] }, { $toDecimal: "$amount" }, 0] } },
      depositCount: { $sum: { $cond: [{ $eq: ["$source", "topup"] }, 1, 0] } },
    } },
    { $project: { _id: 0, credits: { $toDouble: "$credits" }, deposits: { $toDouble: "$deposits" }, depositCount: 1 } },
  ]);
  return result || { credits: 0, deposits: 0, depositCount: 0 };
}

module.exports = { projectRevenue, legacyRevenue, walletFunding };
