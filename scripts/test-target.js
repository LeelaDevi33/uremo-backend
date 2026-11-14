// Legacy write tests must target the same isolated environment as their fixtures.
const target = process.env.UREMO_STAGING_API_URL || process.env.API_URL || process.env.API_BASE;
if (!target) throw new Error("Set UREMO_STAGING_API_URL to a staging or loopback API origin.");
const url = new URL(target);
const hostname = url.hostname.replace(/\.$/, "");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
const stagingHost = /(^|[.-])(staging|stage|test)([.-]|$)/i.test(hostname);
if (hostname === "uremo-backend.onrender.com" ||
    (!local && (!stagingHost || url.protocol !== "https:")) ||
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) {
  throw new Error("Write tests require a loopback origin or an HTTPS staging/test hostname.");
}

function testCredentials(prefix) {
  const email = process.env[prefix + "_EMAIL"]?.trim();
  const password = process.env[prefix + "_PASSWORD"];
  if (!email || !password) throw new Error("Set " + prefix + "_EMAIL and " + prefix + "_PASSWORD for the test account.");
  return { email, password };
}

function testFetch(resource, options) {
  return fetch(resource, { ...options, redirect: "error" });
}

module.exports = { baseUrl: url.origin, testCredentials, testFetch };
