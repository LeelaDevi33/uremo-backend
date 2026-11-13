const { tokenIdentity } = require("../services/tokenIdentity");
const jwt = require("jsonwebtoken");

function extractToken(req) {
  const headerToken = req.headers.authorization?.split(" ")?.[1];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken;
  return null;
}

module.exports = async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();

  if (!process.env.JWT_SECRET) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await tokenIdentity(decoded);
  } catch {
    // Optional auth: ignore invalid token
  }

  return next();
};
