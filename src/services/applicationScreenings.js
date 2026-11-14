const ApplyWork = require("../models/ApplyWork");
const Screening = require("../models/Screening");
const { roleError } = require("./adminWorkRoles");

const unlocked = ["screening_unlocked", "training_viewed", "screening_available"];
const summaryFields = "title description timeLimit passingScore trainingMaterials active";
const roleFields = "title category hasScreening screeningId screeningIds";

function passedScreening(record) {
  return record.submissionStatus === "approved" ||
    (record.passed === true && !["pending_review", "rejected"].includes(record.submissionStatus));
}

async function requiredScreeningIds(role, category) {
  const ids = [...new Set([...(role?.screeningIds || []), role?.screeningId].filter(Boolean).map(String))];
  if (ids.length || role?.hasScreening === false || !(role?.category || category)) return ids;
  // Historically unlinked assessments were chosen by category. Select the
  // same active test for discovery, opening, submission and staff review.
  const fallback = await Screening.findOne({ category: role?.category || category, active: true })
    .sort({ _id: 1 }).select("_id").lean();
  return fallback ? [String(fallback._id)] : [];
}

async function requiredSummaries(role, category) {
  const ids = await requiredScreeningIds(role, category);
  if (!ids.length) return [];
  const rows = await Screening.find({ _id: { $in: ids } }).select(summaryFields).lean();
  const byId = new Map(rows.map(row => [String(row._id), row]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

async function eligibleApplication(user, screeningId, positionId) {
  const filter = { user, status: "approved", workerStatus: { $in: unlocked } };
  if (positionId) {
    if (!ApplyWork.base.isObjectIdOrHexString(positionId)) throw roleError(400, "Invalid application ID");
    filter.$or = [{ _id: positionId }, { position: positionId }];
  }
  const profiles = await ApplyWork.find(filter).populate("position", roleFields);
  const matches = [];
  for (const profile of profiles) {
    if (!profile.position && profile.populated("position")) continue;
    const ids = await requiredScreeningIds(profile.position, profile.category);
    const alreadyCompleted = profile.screeningsCompleted.some(record =>
      String(record.screeningId) === String(screeningId) && (passedScreening(record) || record.submissionStatus === "pending_review"));
    if (ids.includes(String(screeningId)) && !alreadyCompleted) matches.push({ profile, ids });
  }
  if (!matches.length) throw roleError(403, "An approved application with this screening unlocked is required.");
  if (matches.length > 1) throw roleError(409, "Open this screening from the application you want to use.");
  return matches[0];
}

function afterPassing(profile, required) {
  const passed = new Set(profile.screeningsCompleted.filter(passedScreening).map(record => String(record.screeningId)));
  return required.length > 0 && required.every(id => passed.has(id)) ? "ready_to_work" : "screening_unlocked";
}

// Match the state used to make a decision so a concurrent attempt, changed
// application decision, or staff suspension cannot be overwritten by a save.
function guardScreeningSave(profile) {
  profile.$where = {
    status: profile.status,
    workerStatus: profile.workerStatus,
    attemptCount: profile.attemptCount ? profile.attemptCount : { $in: [0, null] },
    __v: profile.__v == null ? null : profile.__v,
  };
  profile.increment();
}

function screeningErrorStatus(err) {
  if (["VersionError", "DocumentNotFoundError"].includes(err.name)) return 409;
  return err.status || 500;
}

module.exports = { unlocked, summaryFields, roleFields, passedScreening, requiredScreeningIds,
  requiredSummaries, eligibleApplication, afterPassing, guardScreeningSave, screeningErrorStatus };
