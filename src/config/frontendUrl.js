const productionUrl = "https://uremo-frontend.vercel.app";

// Links delivered to a member must open the same environment as its API.
function getFrontendUrl() {
  const value = process.env.FRONTEND_URL?.trim();
  if (!value && process.env.UREMO_ENVIRONMENT === "staging") {
    throw new Error("Staging requires FRONTEND_URL for member links");
  }
  if (!value) return productionUrl;
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*")) {
    throw new Error("FRONTEND_URL must be an exact HTTP or HTTPS origin");
  }
  return url.origin;
}

module.exports = { getFrontendUrl };
