const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("standalone QA scripts reject missing and live targets before connecting", () => {
  const cwd = path.join(__dirname, "..");
  for (const target of ["", "https://uremo-backend.onrender.com", "https://uremo-backend.onrender.com."]) {
    const env = { ...process.env, UREMO_STAGING_API_URL: target, API_URL: "", API_BASE: "" };
    const result = spawnSync(process.execPath, ["scripts/patch44-worker-journey-test.js"], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set UREMO_STAGING_API_URL|Write tests require/);
    assert.equal(result.stdout, "");
  }
  for (const origin of ["http://127.0.0.1:5148", "https://uremo-staging.example.test"]) {
    const env = { ...process.env, UREMO_STAGING_API_URL: origin };
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('./scripts/test-target').baseUrl)"], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, origin);
  }
});
