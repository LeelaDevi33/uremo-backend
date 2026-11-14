const ApplyWork = require("../models/ApplyWork");
const WorkPosition = require("../models/WorkPosition");
const { specializationRoles } = require("./roleCatalog");
function applicationError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function preflightApplication(position, userId) {
  if (!position.active) throw applicationError(400, "This position is not active");
  if (!(await specializationRoles([position])).length) throw applicationError(404, "Work role not found");
  if (await ApplyWork.exists({ user: userId, position: position._id })) throw applicationError(409, "Already applied to this position");
}

async function createRoleApplication(fields) {
  if (fields.resumeUrl) {
    let url;
    try { url = new URL(fields.resumeUrl); } catch { /* Invalid URLs are rejected below. */ }
    if (typeof fields.resumeUrl !== "string" || !/^https:\/\//i.test(fields.resumeUrl) ||
        url?.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw applicationError(400, "Provide an HTTPS resume link without embedded credentials");
    }
  }
  if (!fields.position) return ApplyWork.create(fields);
  return WorkPosition.db.transaction(async session => {
    const role = await WorkPosition.findOneAndUpdate(
      { _id: fields.position, active: true }, { $inc: { applicationRevision: 1 } }, { session, timestamps: false },
    );
    if (!role) throw applicationError(400, "This position is not active");
    if (!(await specializationRoles([role], session)).length) throw applicationError(404, "Work role not found");
    const previous = await ApplyWork.exists({ user: fields.user, position: fields.position }).session(session);
    if (previous) throw applicationError(409, "Already applied to this position");
    const [application] = await ApplyWork.create([fields], { session, ordered: true });
    return application;
  });
}

module.exports = { createRoleApplication, preflightApplication };
