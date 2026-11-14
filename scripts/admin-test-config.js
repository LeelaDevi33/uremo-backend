// Required for the admin scripts that create or edit records.
const target = process.env.UREMO_STAGING_API_URL || process.env.API_URL;
if (!target) throw new Error("Set UREMO_STAGING_API_URL to a staging or loopback API origin.");

const url = new URL(target);
const hostname = url.hostname.replace(/\.$/, "");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
const stagingHost = /(^|[.-])(staging|stage|test)([.-]|$)/i.test(hostname);
if (hostname === "uremo-backend.onrender.com" ||
    (!local && (!stagingHost || url.protocol !== "https:")) ||
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) {
  throw new Error("Admin scripts require a loopback origin or an HTTPS staging/test hostname.");
}

const email = process.env.ADMIN_EMAIL?.trim();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD for the test account.");

// Stop redirects from forwarding an authenticated write to a different service.
function testFetch(resource, options) {
  return fetch(resource, { ...options, redirect: "error" });
}

module.exports = { baseUrl: url.origin, email, password, testFetch };
