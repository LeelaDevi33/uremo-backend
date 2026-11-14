const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("ADMIN");
// Quick test for admin routes availability
const BASE = baseUrl;

async function main() {
  console.log("Testing admin routes availability...");

  const login = await testFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  }).then((r) => r.json());

  if (!login.token) {
    console.log("Login failed:", login);
    return;
  }
  console.log("✅ Login OK, role:", login.user?.role);

  const headers = { Authorization: `Bearer ${login.token}` };

  const routes = [
    "/api/admin/services",
    "/api/admin/work-positions",
    "/api/admin/users",
    "/api/admin/workspace/jobs",
    "/api/admin/apply-work",
    "/api/apply-work/all",
  ];

  console.log("\nRoute availability:");
  for (const route of routes) {
    const res = await testFetch(`${BASE}${route}`, { headers });
    const emoji = res.status === 200 ? "✅" : res.status === 404 ? "❌" : "⚠️";
    console.log(`${emoji} ${route} -> ${res.status}`);
  }
}

main().catch(console.error);
