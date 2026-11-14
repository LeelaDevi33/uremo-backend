const { tokenIdentity } = require("../services/tokenIdentity");
const jwt = require("jsonwebtoken");

module.exports = async (req, res, next) => {
  const headerToken = req.headers.authorization?.split(" ")[1];

  // EventSource cannot send custom headers, so allow query token ONLY for SSE stream.
  const isSseStream =
    req.method === "GET" &&
    typeof req.path === "string" &&
    /\/messages\/stream$/.test(req.path);

  const queryToken =
    isSseStream && typeof req.query?.token === "string"
      ? req.query.token
      : null;

  const token = headerToken || queryToken;

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  if (!process.env.JWT_SECRET) {
    console.error("[AUTH] FATAL: JWT_SECRET environment variable is not set");
    return res.status(500).json({ message: "Server configuration error" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
  try {
    req.user = await tokenIdentity(decoded);
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ message: "Invalid token" });
    return res.status(503).json({ message: "Unable to verify account access. Try again." });
  }
  next();
};
