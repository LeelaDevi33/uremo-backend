const User = require("../models/User");

function sessionIsCurrent(claims, account) {
  return Boolean(account && (claims.sessionVersion ?? 0) === (account.sessionVersion ?? 0) &&
    (!claims.exp || claims.exp * 1000 > Date.now()));
}

async function tokenIdentity(claims) {
  const id = claims?.id || claims?._id || claims?.userId || claims?.uid;
  const account = User.base.isObjectIdOrHexString(id) ? await User.findById(id).select("role sessionVersion").lean() : null;
  if (!sessionIsCurrent(claims, account)) throw Object.assign(new Error("Invalid token identity"), { status: 401 });
  const isAdmin = (claims.role === "admin" || claims.isAdmin === true) && account.role === "admin";
  return { ...claims, id, role: isAdmin ? "admin" : "user", isAdmin };
}

async function activeAccounts(identities) {
  const ids = [...new Set(identities.map(person => String(person.id)))];
  const accounts = await User.find({ _id: { $in: ids } }).select("role sessionVersion").lean();
  return new Map(accounts.map(account => [String(account._id), account]));
}

module.exports = { tokenIdentity, activeAccounts, sessionIsCurrent };
