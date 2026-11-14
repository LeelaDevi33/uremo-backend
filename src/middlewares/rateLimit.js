const { isIP } = require("node:net");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

function clientKey(req) {
  // Render's public ingress overwrites CF-Connecting-IP. A direct local server
  // must ignore forwarding headers and key on the actual socket address.
  const edgeIp = req.get("CF-Connecting-IP");
  const ip = process.env.RENDER === "true" && typeof edgeIp === "string" && isIP(edgeIp) ? edgeIp : req.ip;
  return ipKeyGenerator(ip);
}

module.exports = options => rateLimit({ ...options, keyGenerator: clientKey });
