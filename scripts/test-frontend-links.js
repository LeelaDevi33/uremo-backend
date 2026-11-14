const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getFrontendUrl } = require("../src/config/frontendUrl");
const { welcomeEmail } = require("../src/emails/templates");

test("member links use the deployed site, respect a custom frontend, and stay inside staging", t => {
  const previous = { url: process.env.FRONTEND_URL, tier: process.env.UREMO_ENVIRONMENT };
  t.after(() => {
    if (previous.url == null) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previous.url;
    if (previous.tier == null) delete process.env.UREMO_ENVIRONMENT; else process.env.UREMO_ENVIRONMENT = previous.tier;
  });
  delete process.env.FRONTEND_URL;
  delete process.env.UREMO_ENVIRONMENT;
  assert.equal(getFrontendUrl(), "https://uremo-frontend.vercel.app");
  assert.match(welcomeEmail("Synthetic member"), /href="https:\/\/uremo-frontend\.vercel\.app\/open-roles"/);
  process.env.UREMO_ENVIRONMENT = "staging";
  assert.throws(getFrontendUrl, /Staging requires/);
  process.env.FRONTEND_URL = "https://staging.example.invalid/";
  assert.match(welcomeEmail("Synthetic member"), /href="https:\/\/staging\.example\.invalid\/open-roles"/);
  for (const invalid of ["https://staging.example.invalid/path", "https://staging.example.invalid/?x=1", "ftp://example.invalid"]) {
    process.env.FRONTEND_URL = invalid;
    assert.throws(getFrontendUrl);
  }
});
