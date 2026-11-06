const assert = require("node:assert/strict");

async function main() {
  const base = (process.argv[2] || process.env.UREMO_API_BASE || "http://localhost:5000").replace(/\/+$/, "");
  const get = (path, headers) => fetch(base + path, { headers, signal: AbortSignal.timeout(10000) });
  const live = await get("/api/health");
  assert.equal(live.status, 200);
  assert.equal((await live.json()).status, "ok");

  const ready = await get("/api/health/ready");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ready");

  const route = "/api/jarvisx/admin/health";
  assert.equal((await get(route)).status, 401);
  if (process.env.UREMO_TEST_ADMIN_TOKEN) {
    const response = await get(route, { Authorization: "Bearer " + process.env.UREMO_TEST_ADMIN_TOKEN });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.success, true);
    assert.equal(report.database?.status, "connected");
    assert.ok(Array.isArray(report.sessions) && Array.isArray(report.audit24h));
    console.log("Authenticated operator report passed.");
  }
  console.log("Liveness, database readiness and operator authentication boundary passed.");
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
