const Opportunity = require("../models/Opportunity");
const Grant = require("../models/OpportunityGrant");
const Order = require("../models/Order");
const Ticket = require("../models/Ticket");
const Proof = require("../models/ProofOfWork");
const Application = require("../models/ApplyWork");
const Screening = require("../models/Screening");
const Project = require("../models/Project");
const Dataset = require("../models/Dataset");
const Submission = require("../models/RlhfSubmission");
const User = require("../models/User");
const Withdrawal = require("../models/WithdrawalRequest");
const ReferralWithdrawal = require("../models/AffiliateWithdrawal");
const Transaction = require("../models/WalletTransaction");

exports.overview = async (_req, res, next) => {
  try {
    const now = new Date();
    const [
      published, drafts, activeRentals, sales, pendingOrders, stuckOrders, openTickets,
      pendingProofs, pendingApplications, invalidScreenings, projects, datasets,
      approvedSubmissions, pendingReviews, users, walletWithdrawals, referralWithdrawals, pendingTopups,
    ] = await Promise.all([
      require("./opportunity.controller").publicOfferFacts().then(facts => facts.count),
      Opportunity.countDocuments({ status: "draft" }),
      Grant.countDocuments({ type: "rent", refundedAt: null, endsAt: { $gt: now } }),
      Grant.countDocuments({ type: "buy", refundedAt: null }),
      Order.countDocuments({ status: "pending" }),
      Order.countDocuments({ status: "in_progress", updatedAt: { $lt: new Date(now.getTime() - 48 * 3600000) } }),
      Ticket.countDocuments({ status: "open" }),
      Proof.countDocuments({ status: "pending" }),
      Application.countDocuments({ status: "pending" }),
      Screening.countDocuments({ "questions.0": { $exists: false } }),
      Project.countDocuments(), Dataset.countDocuments(),
      Submission.countDocuments({ reviewStatus: "approved" }),
      Submission.countDocuments({ reviewStatus: "pending_review" }),
      User.countDocuments(), Withdrawal.countDocuments({ status: "pending" }),
      ReferralWithdrawal.countDocuments({ status: "pending" }),
      Transaction.countDocuments({ source: "topup", status: { $in: ["initiated", "pending", "paid_unverified"] } }),
    ]);
    res.set("Cache-Control", "private, no-store").json({
      marketplace: { published, drafts, activeRentals, sales },
      projects, datasets, approvedSubmissions, pendingReviews, users,
      badges: { pendingOrders, stuckOrders, openTickets, pendingProofs, pendingApplications,
        invalidScreenings, walletWithdrawals, referralWithdrawals, pendingTopups },
    });
  } catch (err) { next(err); }
};

exports.receipts = async (req, res, next) => {
  try {
    const { type, before } = req.query;
    if ((type && !["rent", "buy"].includes(type)) || (before && (typeof before !== "string" || !/^[a-f\d]{24}$/i.test(before)))) {
      return res.status(400).json({ message: "Invalid receipt filter or cursor" });
    }
    const filter = {};
    if (type) filter.type = type;
    if (before) filter._id = { $lt: before };
    const rows = await Grant.find(filter)
      .select("title userId type amount currency startsAt endsAt refundedAt refundTransactionId +refundReason +refundedBy")
      .populate("userId", "name")
      .sort({ _id: -1 }).limit(26).lean();
    const receipts = rows.slice(0, 25).map(({ userId, ...receipt }) =>
      ({ ...receipt, holder: userId?.name || "Archived account" }));
    res.set("Cache-Control", "private, no-store").json({
      receipts, nextCursor: rows.length > 25 ? receipts[24]._id : null,
    });
  } catch (err) { next(err); }
};
