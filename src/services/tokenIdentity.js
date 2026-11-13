const User = require("../models/User");

async function tokenIdentity(claims) {
  const id = claims?.id || claims?._id || claims?.userId || claims?.uid;
  if (!User.base.isObjectIdOrHexString(id)) throw Object.assign(new Error("Invalid token identity"), { status: 401 });
  const adminClaim = claims.role === "admin" || claims.isAdmin === true;
  const isAdmin = adminClaim && Boolean(await User.exists({ _id: id, role: "admin" }));
  return { ...claims, id, role: isAdmin ? "admin" : "user", isAdmin };
}

async function liveAdminIds(identities) {
  const now = Date.now();
  const ids = identities.filter(person => person?.role === "admin" && (!person.exp || person.exp * 1000 > now)).map(person => person.id);
  if (!ids.length) return new Set();
  const admins = await User.distinct("_id", { _id: { $in: ids }, role: "admin" });
  return new Set(admins.map(String));
}

module.exports = { tokenIdentity, liveAdminIds };
