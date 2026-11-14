const { parseArgs } = require("node:util");
const { MongoClient } = require("mongoose").mongo;

const usage = `Read-only wallet audit of an offline local restore.
  node scripts/reconcile-wallets.js --db RESTORED_DB [--port 27017]
  Exit 0: checks pass. Exit 2: findings or incomplete collections. Exit 1: unable to run.
  Prints aggregate counts only. Never loads environment URIs or opens remote connections.`;
const required = ["users", "withdrawalrequests", "projects", "wallettransactions"];

function connectionArgs(argv) {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" }, port: { type: "string", default: "27017" } } });
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(values.db || "") || ["test", "admin", "config", "local"].includes(values.db.toLowerCase()) ||
      !/^\d{1,5}$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error("Invalid local database name or port");
  }
  return { name: values.db, uri: "mongodb://127.0.0.1:" + values.port };
}

// Accept binary floating point dust from older $inc writes, but report material
// sub-cent values, non-numeric values and values too large for exact cent arithmetic.
function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded / 100) <= 1e-8 ? rounded : null;
}

// Legacy orders also use service_purchase and rental_purchase. Only match those ledger
// entries by receipt ID; an explicit marketplace description also identifies an orphan.
async function inspectAccessReceipts(db, seen, issues) {
  const receipts = new Map();
  const grants = db.collection("opportunitygrants").find({}, { projection: {
    userId: 1, type: 1, currency: 1, amount: 1, refundedAt: 1, refundTransactionId: 1,
  } });
  for await (const grant of grants) {
    seen.accessReceipts++;
    receipts.set(String(grant._id), { grant, debits: 0, refunds: 0, valid: true });
  }
  const ledger = db.collection("wallettransactions").find({
    status: "success", source: { $in: ["rental_purchase", "service_purchase", "refund"] },
  }, { projection: { user: 1, type: 1, source: 1, amount: 1, referenceId: 1, description: 1, withdrawablePortion: 1 } });
  for await (const entry of ledger) {
    const row = receipts.get(String(entry.referenceId));
    if (!row) {
      if (/^(Opportunity rental|Exclusive opportunity purchase|Project access refund): /.test(entry.description || "")) issues.orphanAccessTransactions++;
      continue;
    }
    const refund = entry.source === "refund";
    if (refund) row.refunds++; else row.debits++;
    const amount = cents(entry.amount);
    const portion = entry.withdrawablePortion == null ? null : cents(entry.withdrawablePortion);
    if (refund) row.refundPortion = portion; else row.debitPortion = portion;
    const expectedSource = row.grant.type === "rent" ? "rental_purchase" : "service_purchase";
    if (amount == null || amount <= 0 || cents(row.grant.amount) !== amount || row.grant.currency !== "USD" ||
        String(entry.user) !== String(row.grant.userId) || entry.type !== (refund ? "credit" : "debit") ||
        (refund ? String(entry._id) !== String(row.grant.refundTransactionId) : entry.source !== expectedSource) ||
        (entry.withdrawablePortion != null && (portion == null || portion < 0 || portion > amount))) row.valid = false;
  }
  for (const row of receipts.values()) {
    if (row.debits !== 1) issues.accessReceiptDebitCount++;
    if (row.refunds !== (row.grant.refundedAt ? 1 : 0) || Boolean(row.grant.refundedAt) !== Boolean(row.grant.refundTransactionId)) issues.accessReceiptRefundCount++;
    if (!row.valid || !["buy", "rent"].includes(row.grant.type) ||
        (row.refunds === 1 && (row.debitPortion ?? 0) !== (row.refundPortion ?? 0))) issues.accessReceiptLedgerMismatch++;
  }
}

async function inspect(db) {
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const missingCollections = required.filter(name => !collections.has(name));
  const seen = { wallets: 0, openWithdrawals: 0, creditedProjects: 0, accessReceipts: 0 };
  const issues = {
    invalidWalletAmounts: 0, negativeWalletAmounts: 0, reservedExceedsTotal: 0, withdrawableExceedsSpendable: 0,
    reservationTotalsMismatch: 0, invalidOpenWithdrawalAmounts: 0, orphanOpenWithdrawals: 0,
    invalidProjectCredits: 0, creditedProjectsWithoutLedger: 0, creditedProjectsWithDuplicateLedger: 0, projectLedgerMismatch: 0,
    accessReceiptDebitCount: 0, accessReceiptRefundCount: 0, accessReceiptLedgerMismatch: 0, orphanAccessTransactions: 0,
  };
  const byUser = new Map();
  const open = db.collection("withdrawalrequests").find({ status: { $in: ["pending", "approved"] } },
    { projection: { _id: 0, userId: 1, amount: 1 } });
  for await (const item of open) {
    seen.openWithdrawals++;
    const id = String(item.userId);
    const group = byUser.get(id) || { amount: 0, count: 0, complete: true };
    group.count++;
    const amount = cents(item.amount);
    if (amount === null || amount < 1000) {
      issues.invalidOpenWithdrawalAmounts++;
      group.complete = false;
    } else group.amount += amount;
    byUser.set(id, group);
  }
  const users = db.collection("users").find({}, {
    projection: { walletBalance: 1, withdrawable: 1, pendingWithdrawals: 1, lifetimeEarnings: 1 },
  });
  for await (const row of users) {
    seen.wallets++;
    const key = String(row._id);
    const group = byUser.get(key);
    byUser.delete(key);
    const values = ["walletBalance", "withdrawable", "pendingWithdrawals", "lifetimeEarnings"]
      .map(field => cents(Object.hasOwn(row, field) ? row[field] : 0));
    if (values.includes(null)) issues.invalidWalletAmounts++;
    if (values.some(value => value !== null && value < 0)) issues.negativeWalletAmounts++;
    const [balance, eligible, held] = values;
    if (held !== null && balance !== null && held > balance) issues.reservedExceedsTotal++;
    if (eligible !== null && held !== null && balance !== null && eligible > Math.max(0, balance - held)) issues.withdrawableExceedsSpendable++;
    if (held !== null && (!group || group.complete) && held !== (group?.amount || 0)) issues.reservationTotalsMismatch++;
  }
  for (const orphan of byUser.values()) issues.orphanOpenWithdrawals += orphan.count;

  const projects = new Map();
  const credited = db.collection("projects").find({ earningsCredited: { $nin: [null, 0], $exists: true } },
    { projection: { assignedTo: 1, earningsCredited: 1 } });
  for await (const project of credited) {
    seen.creditedProjects++;
    const amount = cents(project.earningsCredited);
    if (amount === null || amount <= 0 || !project.assignedTo) issues.invalidProjectCredits++;
    projects.set(String(project._id), { user: String(project.assignedTo), amount, count: 0, matches: true });
  }
  const ledger = db.collection("wallettransactions").find({ source: "earning", status: "success" },
    { projection: { _id: 0, user: 1, referenceId: 1, amount: 1, type: 1 } });
  for await (const row of ledger) {
    const project = projects.get(String(row.referenceId));
    if (!project) continue; // Other kinds of earnings may also use this source.
    project.count++;
    if (row.type !== "credit" || String(row.user) !== project.user || cents(row.amount) !== project.amount) project.matches = false;
  }
  for (const project of projects.values()) {
    if (!project.count) issues.creditedProjectsWithoutLedger++;
    if (project.count > 1) issues.creditedProjectsWithDuplicateLedger++;
    if (!project.matches) issues.projectLedgerMismatch++;
  }
  if (collections.has("opportunities") && !collections.has("opportunitygrants")) missingCollections.push("opportunitygrants");
  await inspectAccessReceipts(db, seen, issues);
  const clean = !missingCollections.length && Object.values(issues).every(n => n === 0);
  return { result: clean ? "pass" : "review", missingCollections, scanned: seen, findings: issues };
}

async function main(argv) {
  if (argv.includes("--help")) { console.log(usage); return 0; }
  const { name, uri } = connectionArgs(argv);
  const client = new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 4000 });
  try {
    await client.connect();
    const report = await inspect(client.db(name));
    console.log(JSON.stringify(report, null, 2));
    return report.result === "pass" ? 0 : 2;
  } finally { await client.close(); }
}
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error("Audit could not run. Check --help and access to the restored local MongoDB database.");
    process.exitCode = 1;
  });
}
module.exports = { inspect, connectionArgs };
