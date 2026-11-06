const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const Grant = require("../models/OpportunityGrant");
const User = require("../models/User");
const WalletTransaction = require("../models/WalletTransaction");
const WorkPosition = require("../models/WorkPosition");

const categories = Opportunity.schema.path("category").enumValues;
const limits = { title: 160, description: 4000, category: 80, deliverable: 8000 };
const modes = ["applyEnabled", "rentEnabled", "buyEnabled", "rightsConfirmed"];
const editable = new Set([...Object.keys(limits), ...modes, "status", "workPositionId", "rentPrice", "rentalDays", "buyPrice", "currency"]);
const day = 24 * 60 * 60 * 1000;

function error(status, message, fields) {
  return Object.assign(new Error(message), { status, fields });
}
function isMoney(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    Number.isSafeInteger(Math.round(value * 100)) && Number(value.toFixed(2)) === value;
}
function validId(id) {
  if (!mongoose.isObjectIdOrHexString(id)) throw error(404, "Opportunity not found");
}
function listingView(item, { admin = false, handoff = false } = {}) {
  const availability = item.soldAt ? "sold" : item.rentedUntil > new Date() ? "rented" : "available";
  const result = {
    _id: item._id, title: item.title, description: item.description, category: item.category, status: item.status,
    availability, applyEnabled: admin ? item.applyEnabled : Boolean(item.applyEnabled && !item.soldAt && item.workPositionId),
    workPositionId: item.workPositionId?._id || item.workPositionId || null,
    rentEnabled: item.rentEnabled, rentPrice: item.rentPrice, rentalDays: item.rentalDays,
    buyEnabled: item.buyEnabled, buyPrice: item.buyPrice, currency: item.currency,
  };
  if (admin) {
    result.rightsConfirmed = item.rightsConfirmed;
    result.firstPublishedAt = item.firstPublishedAt || null;
    if (handoff) result.deliverable = item.deliverable || "";
  }
  return result;
}
function grantView(grant, now = new Date()) {
  return {
    _id: grant._id, opportunityId: grant.opportunityId, title: grant.title, type: grant.type,
    amount: grant.amount, currency: grant.currency, startsAt: grant.startsAt, endsAt: grant.endsAt,
    active: grant.startsAt <= now && (!grant.endsAt || grant.endsAt > now),
  };
}

function validateEdit(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw error(400, "Expected a listing object");
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!editable.has(key)) throw error(400, "Unknown or protected field: " + key);
    if (Object.hasOwn(limits, key)) {
      if (typeof value !== "string" || value.trim().length > limits[key]) throw error(400, "Invalid " + key);
      patch[key] = value.trim();
    } else if (modes.includes(key)) {
      if (typeof value !== "boolean") throw error(400, "Invalid " + key);
      patch[key] = value;
    } else if (key === "workPositionId") {
      if (value != null && value !== "" && !mongoose.isObjectIdOrHexString(value)) throw error(400, "Invalid work role");
      patch[key] = value || null;
    } else if (key === "status") {
      if (!["draft", "published", "archived"].includes(value)) throw error(400, "Invalid listing status");
      patch[key] = value;
    } else if (key === "currency") {
      if (value !== "USD") throw error(400, "Wallet prices must be in USD");
      patch[key] = value;
    } else if (key === "rentalDays") {
      if (!Number.isInteger(value) || value < 0 || value > 365) throw error(400, "Rental term must be 0–365 whole days");
      patch[key] = value;
    } else {
      if (!isMoney(value)) throw error(400, "Prices must be nonnegative USD amounts with at most two decimals");
      patch[key] = value;
    }
  }
  if (patch.category && !categories.includes(patch.category)) throw error(400, "Choose a project-work category");
  return patch;
}

async function saveListing(req, res) {
  const id = req.params.id;
  if (id) validId(id);
  const patch = validateEdit(req.body);
  if (id && !Object.keys(patch).length) throw error(400, "Include a field to update");
  let saved;
  try {
    saved = await Opportunity.db.transaction(async session => {
      const item = id ? await Opportunity.findById(id).select("+deliverable").session(session) : new Opportunity();
      if (!item) throw error(404, "Opportunity not found");
      if (item.soldAt && (Object.keys(patch).length !== 1 || patch.status !== "archived")) {
        throw error(409, "A sold opportunity can only be archived");
      }
      if (item.firstPublishedAt && "workPositionId" in patch && String(patch.workPositionId) !== String(item.workPositionId)) {
        throw error(409, "A published opportunity cannot be linked to a different work role");
      }
      const previousRole = item.workPositionId;
      item.set(patch);
      const publishing = item.status === "published";
      if (publishing) {
        if (!item.title || !item.description || !item.category || !item.rightsConfirmed) {
          throw error(400, "Publishing requires a title, description, project category and confirmed rights");
        }
        if (!item.applyEnabled && !item.rentEnabled && !item.buyEnabled) throw error(400, "Enable an application, rental or purchase option");
        if (item.applyEnabled && !item.workPositionId) throw error(400, "Choose an active work role for applications");
        if (item.rentEnabled && (item.rentPrice <= 0 || item.rentalDays < 1)) throw error(400, "A rental needs a positive price and a term of 1–365 days");
        if (item.buyEnabled && item.buyPrice <= 0) throw error(400, "A purchase needs a positive price");
        if ((item.rentEnabled || item.buyEnabled) && !item.deliverable) throw error(400, "A paid opportunity requires a private deliverable");
        item.firstPublishedAt ||= new Date();
      }
      // Serialize linking a role with simultaneous applications, even before a listing exists.
      if (item.workPositionId && (publishing && item.applyEnabled || !previousRole || String(previousRole) !== String(item.workPositionId))) {
        const query = { _id: item.workPositionId };
        if (publishing && item.applyEnabled) query.active = true;
        const role = await WorkPosition.findOneAndUpdate(query, { $inc: { applicationRevision: 1 } }, { session, timestamps: false });
        if (!role) throw error(400, "The selected work role does not exist or is inactive");
        const linked = await Opportunity.exists({ workPositionId: item.workPositionId, _id: { $ne: item._id } }).session(session);
        if (linked) throw error(409, "That work role is already linked to another opportunity");
      }
      await item.save({ session });
      return item;
    });
  } catch (err) {
    if (err.code === 11000) throw error(409, "That work role is already linked to another opportunity");
    throw err;
  }
  res.status(id ? 200 : 201).json({ ok: true, opportunity: listingView(saved, { admin: true, handoff: true }) });
}

async function publicListings(req, res) {
  const items = await Opportunity.find({ status: "published", rightsConfirmed: true, soldAt: null })
    .populate({ path: "workPositionId", match: { active: true }, select: "_id" }).sort({ createdAt: -1 }).lean();
  res.json({ ok: true, opportunities: items.map(item => listingView(item)) });
}
async function publicDetail(req, res) {
  validId(req.params.id);
  const item = await Opportunity.findOne({ _id: req.params.id, status: "published", rightsConfirmed: true })
    .populate({ path: "workPositionId", match: { active: true }, select: "_id" }).lean();
  if (!item) throw error(404, "Opportunity not found");
  res.json({ ok: true, opportunity: listingView(item) });
}
async function adminListings(req, res) {
  const items = await Opportunity.find().sort({ updatedAt: -1 }).lean();
  res.json({ ok: true, opportunities: items.map(item => listingView(item, { admin: true })) });
}
async function adminDetail(req, res) {
  validId(req.params.id);
  const item = await Opportunity.findById(req.params.id).select("+deliverable").lean();
  if (!item) throw error(404, "Opportunity not found");
  res.json({ ok: true, opportunity: listingView(item, { admin: true, handoff: true }) });
}

function replay(grant, id, type, expectedAmount, expectedRentalDays) {
  if (String(grant.opportunityId) !== id.toLowerCase() || grant.type !== type || grant.amount !== expectedAmount ||
      (type === "rent" && grant.rentalDays !== expectedRentalDays)) {
    throw error(409, "This request ID was already used for different terms");
  }
  return { ok: true, grant: grantView(grant), walletBalance: grant.balanceAfter, replayed: true };
}
function checkout(type) {
  return async (req, res) => {
    const id = req.params.id;
    validId(id);
    const { requestId, expectedAmount, expectedRentalDays } = req.body || {};
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw error(400, "Provide a unique request ID");
    if (!isMoney(expectedAmount) || expectedAmount <= 0) throw error(400, "Confirm the displayed USD price");
    if (type === "rent" && (!Number.isInteger(expectedRentalDays) || expectedRentalDays < 1 || expectedRentalDays > 365)) {
      throw error(400, "Confirm the displayed rental term");
    }
    const userId = req.user.id;
    const request = { userId, requestId };
    let result;
    try {
      result = await Opportunity.db.transaction(async session => {
        const prior = await Grant.findOne(request).session(session).lean();
        if (prior) return replay(prior, id, type, expectedAmount, expectedRentalDays);

        const now = new Date();
        const item = await Opportunity.findOne({ _id: id, status: "published", rightsConfirmed: true })
          .select("+deliverable").session(session);
        if (!item) throw error(404, "Opportunity not found");
        if (item.soldAt || item.rentedUntil > now) throw error(409, "This opportunity is already sold or rented");
        const isRental = type === "rent";
        if (!(isRental ? item.rentEnabled : item.buyEnabled)) throw error(409, "This option is unavailable");
        const amount = isRental ? item.rentPrice : item.buyPrice;
        if (amount !== expectedAmount || (isRental && item.rentalDays !== expectedRentalDays)) {
          throw error(409, "The listing terms changed. Refresh before paying");
        }
        if (!item.deliverable) throw error(409, "The private deliverable is unavailable");
        const until = isRental ? new Date(now.getTime() + item.rentalDays * day) : null;
        if (isRental) item.rentedUntil = until;
        else item.soldAt = now;
        await item.save({ session });

        // Use decimal subtraction so a sequence of cent-sized purchases does not
        // leave a binary rounding residue in the existing number-valued USD wallet.
        const previousAccount = await User.findOneAndUpdate(
          { _id: userId, walletBalance: { $gte: amount } },
          [{ $set: { walletBalance: { $toDouble: { $subtract: [
            { $toDecimal: "$walletBalance" }, { $toDecimal: amount.toFixed(2) },
          ] } }, lastWalletUpdate: now } }],
          { new: false, session, updatePipeline: true },
        ).select("walletBalance");
        if (!previousAccount) {
          const user = await User.findById(userId).select("walletBalance").session(session).lean();
          if (!user) throw error(404, "Wallet not found");
          throw error(402, "Insufficient wallet balance", { required: amount, available: user.walletBalance || 0 });
        }
        const account = await User.findById(userId).select("walletBalance").session(session).lean();
        const [grant] = await Grant.create([{
          opportunityId: item._id, userId, type, requestId, title: item.title, deliverable: item.deliverable,
          amount, currency: "USD", startsAt: now, endsAt: until, rentalDays: isRental ? item.rentalDays : null,
          balanceAfter: account.walletBalance,
        }], { session, ordered: true });
        await WalletTransaction.create([{
          user: userId, type: "debit", source: isRental ? "rental_purchase" : "service_purchase",
          status: "success", provider: "internal", referenceId: grant._id, amount,
          balanceBefore: previousAccount.walletBalance, balanceAfter: account.walletBalance,
          description: (isRental ? "Opportunity rental: " : "Exclusive opportunity purchase: ") + item.title,
        }], { session, ordered: true });
        return { ok: true, grant: grantView(grant, now), walletBalance: account.walletBalance, replayed: false };
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const prior = await Grant.findOne(request).lean();
      if (!prior) throw error(409, "This opportunity has already been sold");
      result = replay(prior, id, type, expectedAmount, expectedRentalDays);
    }
    res.status(result.replayed ? 200 : 201).json(result);
  };
}

async function mine(req, res) {
  const grants = await Grant.find({ userId: req.user.id }).sort({ startsAt: -1 }).lean();
  res.json({ ok: true, grants: grants.map(grant => grantView(grant)) });
}
async function access(req, res) {
  validId(req.params.id);
  const now = new Date();
  const grant = await Grant.findOne({
    userId: req.user.id, opportunityId: req.params.id, startsAt: { $lte: now },
    $or: [{ type: "buy", endsAt: null }, { type: "rent", endsAt: { $gt: now } }],
  }).select("+deliverable").sort({ startsAt: -1 }).lean();
  if (!grant) throw error(403, "An active rental or purchase is required");
  res.json({ ok: true, grant: grantView(grant, now), deliverable: grant.deliverable });
}

module.exports = { saveListing, publicListings, publicDetail, adminListings, adminDetail, checkout, mine, access };
