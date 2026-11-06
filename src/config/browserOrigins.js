const allowedOrigins = new Set([
  "https://uremo-frontend.vercel.app",
  "https://uremo-frontend-git-main-uremos-projects.vercel.app",
  "http://localhost:3000",
]);

const configuredOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(","),
];
for (const entry of configuredOrigins) {
  const value = entry?.trim();
  if (!value) continue;
  if (!URL.canParse(value)) throw new Error("Invalid configured frontend origin");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.hostname.includes("*") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Configured frontend origins must be exact HTTP or HTTPS origins");
  }
  allowedOrigins.add(url.origin);
}

function isAllowedOrigin(origin) {
  return origin === undefined || allowedOrigins.has(origin);
}

function checkCorsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) return callback(null, true);
  const error = new Error("Browser origin is not permitted");
  error.status = 403;
  return callback(error, false);
}

module.exports = { isAllowedOrigin, checkCorsOrigin };
