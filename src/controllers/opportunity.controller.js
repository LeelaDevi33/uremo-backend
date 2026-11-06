const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const Grant = require("../models/OpportunityGrant");
const { changeFunds } = require("../services/walletFunds");
const WalletTransaction = require("../models/WalletTransaction");
const WorkPosition = require("../models/WorkPosition");
const Project = require("../models/Project");
const ApplyWork = require("../models/ApplyWork");
const { specializationRoles } = require("../services/roleCatalog");
const { meetsScreenings } = require("../services/roleProjects");

const categories = Opportunity.schema.path("category").enumValues;
const limits = { title: 160, description: 4000, category: 80, deliverable: 8000 };
const modes = ["applyEnabled", "rentEnabled", "buyEnabled", "rightsConfirmed"];
const editable = new Set([...Object.keys(limits), ...modes, "status", "projectId", "workPositionId", "rentPrice", "rentalDays", "buyPrice", "currency"]);
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
function listingTimestamp(item) {
  return item.updatedAt || item.createdAt || item._id.getTimestamp();
}
// Older imports can lack timestamps. Advance by at least 1 ms so two writes in
// the same clock tick cannot present the same optimistic-lock token.
async function saveRevision(item, session) {
  if (item.isNew) return item.save({ session });
  item.updatedAt = new Date(Math.max(Date.now(), listingTimestamp(item).getTime() + 1));
  return item.save({ session, timestamps: false });
}
function listingView(item, { admin = false, handoff = false, project, role, settled = false, held } = {}) {
  const canonical = Boolean(item.projectId && item.projectRoleId && !item.workPositionId && item.applyEnabled === false);
  const availability = item.soldAt || held === "buy" ? "sold" : item.rentedUntil > new Date() || held === "rent" ? "rented" : "available";
  const result = {
    _id: item._id, title: item.title, description: item.description, category: item.category, status: item.status,
    revision: listingTimestamp(item).toISOString(),
    availability, applyEnabled: Boolean(admin && item.applyEnabled), kind: canonical ? "project" : "legacy", needsReview: !canonical,
    projectId: item.projectId || null, projectTitle: project?.title || "",
    workPositionId: item.projectRoleId || item.workPositionId || null, workPositionTitle: role?.title || "",
    rentEnabled: item.rentEnabled, rentPrice: item.rentPrice, rentalDays: item.rentalDays,
    buyEnabled: item.buyEnabled, buyPrice: item.buyPrice, currency: item.currency,
  };
  if (admin) {
    result.rightsConfirmed = item.rightsConfirmed;
    result.firstPublishedAt = (canonical ? item.projectPublishedAt : item.firstPublishedAt) || null;
    result.canConvert = !canonical && !settled && !item.rentedUntil && !item.soldAt;
    if (handoff) result.deliverable = item.deliverable || "";
  }
  return result;
}
function grantView(grant, now = new Date()) {
  return {
    _id: grant._id, opportunityId: grant.opportunityId, title: grant.title, type: grant.type,
    projectScope: grant.projectScope || "",
    projectId: grant.projectId || null, workPositionId: grant.workPositionId || null,
    amount: grant.amount, currency: grant.currency, startsAt: grant.startsAt, endsAt: grant.endsAt,
    active: grant.startsAt <= now && (grant.type === "buy" && grant.endsAt == null || grant.type === "rent" && grant.endsAt > now),
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
    } else if (key === "workPositionId" || key === "projectId") {
      if (value != null && value !== "" && !mongoose.isObjectIdOrHexString(value)) throw error(400, "Invalid " + key);
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
  let fields = req.body;
  let expectedRevision;
  if (id && fields && typeof fields === "object" && !Array.isArray(fields)) {
    ({ expectedRevision, ...fields } = fields);
    if (expectedRevision === undefined) throw error(428, "Reload this listing before saving.");
    if (typeof expectedRevision !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expectedRevision)) {
      throw error(400, "Invalid listing revision");
    }
  }
  const patch = validateEdit(fields);
  if (id && !Object.keys(patch).length) throw error(400, "Include a field to update");
  let saved;
  try {
    saved = await Opportunity.db.transaction(async session => {
      const item = id ? await Opportunity.findById(id).select("+deliverable +preserveRoleUntilPublished").session(session) : new Opportunity();
      if (!item) throw error(404, "Opportunity not found");
      if (id && expectedRevision !== listingTimestamp(item).toISOString()) {
        throw error(409, "This listing changed. Reload before saving.");
      }
      const archiving = id && Object.keys(patch).length === 1 && patch.status === "archived";
      if (archiving) {
        item.status = "archived";
        await saveRevision(item, session);
        return item;
      }
      if (item.soldAt || id && await Grant.exists({ opportunityId: id, type: "buy" }).session(session)) {
        throw error(409, "A sold opportunity can only be archived");
      }
      const legacy = id && (!item.projectId || !item.projectRoleId || item.workPositionId || item.applyEnabled !== false);
      const identityChange = patch.projectId && String(item.projectId) !== String(patch.projectId);
      if (legacy || identityChange) {
        const settled = id && (item.rentedUntil || await Grant.exists({ opportunityId: id }).session(session));
        if (settled || (!legacy && item.projectPublishedAt)) throw error(409, "The project identity is locked by its publication or settlement history");
      }
      if (legacy && (!patch.projectId || patch.applyEnabled !== false || patch.status !== "draft")) {
        throw error(409, "Archive this legacy listing or explicitly map an unsettled listing to a project draft");
      }
      if (patch.applyEnabled === true) throw error(400, "Applications are available only through work roles");
      const projectId = patch.projectId === undefined ? item.projectId : patch.projectId;
      if (!projectId) throw error(400, "Choose an existing project");
      // A real write serializes publication with concurrent project edits/deletions
      // and competing offers, including before the project uniqueness index exists.
      const project = await Project.findOneAndUpdate({ _id: projectId, ...staffingFilter },
        { $inc: { paidOfferRevision: 1 } }, { session, timestamps: false }).select("workPositionId");
      if (!project?.workPositionId) throw error(400, "Choose an unassigned draft or open project with a work specialization");
      if (patch.workPositionId && String(patch.workPositionId) !== String(project.workPositionId)) {
        throw error(400, "The specialization must match the chosen project");
      }
      if (!legacy && item.projectRoleId && !identityChange && !item.projectRoleId.equals(project.workPositionId)) {
        throw error(409, "The linked project specialization changed; archive this offer for review");
      }
      const role = await WorkPosition.findByIdAndUpdate(project.workPositionId, { $inc: { applicationRevision: 1 } },
        { session, timestamps: false }).select(roleFields);
      if (!role || !(await specializationRoles([role], session)).length) throw error(400, "The linked project specialization does not exist");
      if (await Opportunity.exists({ projectId, _id: { $ne: item._id } }).session(session)) {
        throw error(409, "This project already has an offer");
      }
      item.set({ ...patch, projectId, projectRoleId: project.workPositionId, workPositionId: null, applyEnabled: false,
        preserveRoleUntilPublished: false });
      if (item.status === "published") {
        if (!item.title || !item.description || !item.category || !item.rightsConfirmed) {
          throw error(400, "Publishing requires a title, description, project category and confirmed rights");
        }
        if (!item.rentEnabled && !item.buyEnabled) throw error(400, "Enable rent, full access, or both");
        if (item.rentEnabled && (item.rentPrice <= 0 || item.rentalDays < 1)) throw error(400, "A rental needs a positive price and a term of 1–365 days");
        if (item.buyEnabled && item.buyPrice <= 0) throw error(400, "Full access needs a positive price");
        if (!item.deliverable) throw error(400, "A paid opportunity requires a private deliverable");
        item.firstPublishedAt ||= new Date();
        item.projectPublishedAt ||= new Date();
      }
      await saveRevision(item, session);
      return item;
    });
  } catch (err) {
    if (err.code === 11000) throw error(409, "This project already has an offer");
    throw err;
  }
  res.status(id ? 200 : 201).json({ ok: true, opportunity: (await adminViews([saved], true))[0] });
}

const staffingFilter = { status: { $in: ["draft", "open"] }, assignedTo: null };
const qualifiedStatuses = ["ready_to_work", "assigned", "working"];
const publishedOffer = { status: "published", rightsConfirmed: true, applyEnabled: false, workPositionId: null,
  projectId: { $type: "objectId" }, projectRoleId: { $type: "objectId" }, projectPublishedAt: { $type: "date" } };
const contextFields = "title workPositionId status screeningId screeningIds";
const roleFields = "title category serviceId active hasScreening screeningId screeningIds";

function validTerms(item) {
  return item.currency === "USD" && (item.buyEnabled || item.rentEnabled) &&
    (!item.buyEnabled || isMoney(item.buyPrice) && item.buyPrice > 0) &&
    (!item.rentEnabled || isMoney(item.rentPrice) && item.rentPrice > 0 &&
      Number.isInteger(item.rentalDays) && item.rentalDays > 0 && item.rentalDays <= 365);
}
function qualified(worker, project, role) {
  return role.active && String(worker.position) === String(role._id) && meetsScreenings(worker, project, role);
}
function applicationFilter(userId, roleIds) {
  return { user: userId, status: "approved", workerStatus: { $in: qualifiedStatuses }, position: { $in: roleIds } };
}

// The immutable grant is a second inventory check if an imported listing's
// mutable sold/rental markers were lost. Buy receipts reserve the project permanently.
function heldInventory(projectIds, now) {
  return Grant.find({ projectId: { $in: projectIds }, $or: [
    { type: "buy" }, { type: "rent", endsAt: { $gt: now } }, { type: "rent", endsAt: null },
  ] }).select("projectId type");
}

async function publishedViews(filter, userId) {
  const items = await Opportunity.find({ ...publishedOffer, ...filter }).sort({ createdAt: -1 }).lean();
  const projectIds = items.map(item => item.projectId), roleIds = items.map(item => item.projectRoleId);
  const [projects, roles, workers, grants] = await Promise.all([
    Project.find({ _id: { $in: projectIds }, ...staffingFilter }).select(contextFields).lean(),
    WorkPosition.find({ _id: { $in: roleIds } }).select(roleFields).lean(),
    userId ? ApplyWork.find(applicationFilter(userId, roleIds)).select("position screeningsCompleted").lean() : [],
    heldInventory(projectIds, new Date()).lean(),
  ]);
  const holds = new Map();
  for (const grant of grants) {
    const key = String(grant.projectId);
    if (holds.get(key) !== "buy") holds.set(key, grant.type);
  }
  const byProject = new Map(projects.map(p => [String(p._id), p])), byRole = new Map((await specializationRoles(roles)).map(r => [String(r._id), r]));
  const views = [];
  for (const item of items) {
    const project = byProject.get(String(item.projectId)), role = byRole.get(String(item.projectRoleId));
    if (!project || !role || String(project.workPositionId) !== String(role._id) || !validTerms(item)) continue;
    const view = listingView(item, { project, role, held: holds.get(String(item.projectId)) });
    if (Object.hasOwn(filter, "soldAt") && view.availability === "sold") continue;
    view.canRent = Boolean(userId && item.rentEnabled && view.availability === "available" && workers.some(w => qualified(w, project, role)));
    view.canBuy = Boolean(userId && item.buyEnabled && view.availability === "available");
    views.push(view);
  }
  return views;
}
async function publicOfferFacts() {
  const views = await publishedViews({ soldAt: null });
  return { count: views.length, categories: [...new Set(views.map(v => v.category).filter(Boolean))].sort() };
}
async function publicListings(req, res) {
  res.json({ ok: true, opportunities: await publishedViews({ soldAt: null }, req.user?.id) });
}
async function publicDetail(req, res) {
  validId(req.params.id);
  const [opportunity] = await publishedViews({ _id: req.params.id }, req.user?.id);
  if (!opportunity) throw error(404, "Opportunity not found");
  res.json({ ok: true, opportunity });
}
async function adminViews(items, handoff) {
  const [projects, roles, settled, grants] = await Promise.all([
    Project.find({ _id: { $in: items.map(i => i.projectId).filter(Boolean) } }).select("title").lean(),
    WorkPosition.find({ _id: { $in: items.map(i => i.projectRoleId || i.workPositionId).filter(Boolean) } }).select("title").lean(),
    Grant.distinct("opportunityId", { opportunityId: { $in: items.map(i => i._id) } }),
    heldInventory(items.map(i => i.projectId).filter(Boolean), new Date()).lean(),
  ]);
  const byProject = new Map(projects.map(p => [String(p._id), p])), byRole = new Map(roles.map(r => [String(r._id), r]));
  const receipts = new Set(settled.map(String));
  const holds = new Map();
  for (const grant of grants) {
    const key = String(grant.projectId);
    if (holds.get(key) !== "buy") holds.set(key, grant.type);
  }
  return items.map(item => listingView(item, { admin: true, handoff, project: byProject.get(String(item.projectId)),
    role: byRole.get(String(item.projectRoleId || item.workPositionId)), settled: receipts.has(String(item._id)), held: holds.get(String(item.projectId)) }));
}
async function adminListings(req, res) {
  res.json({ ok: true, opportunities: await adminViews(await Opportunity.find().sort({ updatedAt: -1 }).lean(), false) });
}
async function adminDetail(req, res) {
  validId(req.params.id);
  const item = await Opportunity.findById(req.params.id).select("+deliverable").lean();
  if (!item) throw error(404, "Opportunity not found");
  res.json({ ok: true, opportunity: (await adminViews([item], true))[0] });
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
    const { requestId, expectedAmount, expectedRentalDays, expectedRevision } = req.body || {};
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
        const item = await Opportunity.findOne({ _id: id, ...publishedOffer })
          .select("+deliverable").session(session);
        if (!item) throw error(404, "Opportunity not found");
        if (!validTerms(item)) throw error(409, "This project offer requires review");
        const project = await Project.findOneAndUpdate({ _id: item.projectId, workPositionId: item.projectRoleId, ...staffingFilter },
          { $inc: { paidOfferRevision: 1 } }, { session, timestamps: false }).select(contextFields).lean();
        const role = await WorkPosition.findByIdAndUpdate(item.projectRoleId, { $inc: { applicationRevision: 1 } },
          { session, timestamps: false }).select(roleFields).lean();
        if (!project || !role || !(await specializationRoles([role], session)).length) throw error(404, "Opportunity not found");
        if (item.soldAt || item.rentedUntil > now || (await heldInventory([project._id], now).limit(1).session(session).lean()).length) {
          throw error(409, "This opportunity is already sold or rented");
        }
        if (expectedRevision !== undefined && expectedRevision !== listingTimestamp(item).toISOString()) {
          throw error(409, "The project brief or terms changed. Review the listing again.");
        }
        const isRental = type === "rent";
        if (!(isRental ? item.rentEnabled : item.buyEnabled)) throw error(409, "This option is unavailable");
        if (isRental) {
          const filter = applicationFilter(userId, [role._id]);
          const profiles = await ApplyWork.find(filter).select("position screeningsCompleted").session(session).lean();
          const eligible = profiles.find(w => qualified(w, project, role));
          if (!eligible) throw error(403, "Renting requires approval and completed screenings in this project's specialization");
          // Serialize settlement with withdrawal of the selected qualification.
          await ApplyWork.updateOne({ _id: eligible._id }, { $inc: { paidOfferRevision: 1 } }, { session, timestamps: false });
        }
        const amount = isRental ? item.rentPrice : item.buyPrice;
        if (amount !== expectedAmount || (isRental && item.rentalDays !== expectedRentalDays)) {
          throw error(409, "The listing terms changed. Refresh before paying");
        }
        if (!item.deliverable) throw error(409, "The private deliverable is unavailable");
        const until = isRental ? new Date(now.getTime() + item.rentalDays * day) : null;
        if (isRental) item.rentedUntil = until;
        else item.soldAt = now;
        await saveRevision(item, session);

        const account = await changeFunds(userId, amount, "spend", session);
        const [grant] = await Grant.create([{
          opportunityId: item._id, projectId: project._id, workPositionId: role._id, userId, type, requestId, title: item.title, projectScope: item.description, deliverable: item.deliverable,
          amount, currency: "USD", startsAt: now, endsAt: until, rentalDays: isRental ? item.rentalDays : null,
          balanceAfter: account.walletBalance,
        }], { session, ordered: true });
        await WalletTransaction.create([{
          user: userId, type: "debit", source: isRental ? "rental_purchase" : "service_purchase",
          status: "success", provider: "internal", referenceId: grant._id, amount,
          balanceBefore: account.balanceBefore, balanceAfter: account.walletBalance,
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

module.exports = { publicOfferFacts, saveListing, publicListings, publicDetail, adminListings, adminDetail, checkout, mine, access };
