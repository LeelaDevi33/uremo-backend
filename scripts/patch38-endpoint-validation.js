const { baseUrl, testFetch } = require("./test-target");
/**
 * PATCH_38: Endpoint Validation (No Auth Required)
 * Tests all API endpoints exist and respond correctly
 *
 * Run: node scripts/patch38-endpoint-validation.js
 */

const BASE_URL = baseUrl;

// Test results storage
const results = {
  endpoints: [],
  passes: 0,
  fails: 0,
};

function log(category, endpoint, result, details = "") {
  const icon = result === "PASS" ? "✅" : result === "FAIL" ? "❌" : "⏭️";
  console.log(`${icon} [${category}] ${endpoint}: ${result} ${details}`);
  results.endpoints.push({ category, endpoint, result, details });
  if (result === "PASS") results.passes++;
  if (result === "FAIL") results.fails++;
}

async function testEndpoint(category, endpoint, options = {}) {
  const {
    method = "GET",
    expectedStatus = [200],
    requiresAuth = false,
    body = null,
  } = options;

  try {
    const headers = { "Content-Type": "application/json" };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await testFetch(`${BASE_URL}${endpoint}`, opts);
    const data = await res.json().catch(() => ({}));

    if (requiresAuth && res.status === 401) {
      log(category, endpoint, "PASS", "(401 - Auth required, as expected)");
      return { exists: true, requiresAuth: true };
    }

    if (expectedStatus.includes(res.status)) {
      log(category, endpoint, "PASS", `(${res.status})`);
      return { exists: true, status: res.status, data };
    } else {
      log(category, endpoint, "FAIL", `Unexpected status: ${res.status}`);
      return { exists: false, status: res.status };
    }
  } catch (err) {
    log(category, endpoint, "FAIL", `Error: ${err.message}`);
    return { exists: false, error: err.message };
  }
}

async function main() {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║  PATCH_38: ENDPOINT VALIDATION                               ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  API: ${BASE_URL.padEnd(55)}║`);
  console.log(`║  Time: ${new Date().toISOString().padEnd(54)}║`);
  console.log(
    "╚══════════════════════════════════════════════════════════════╝\n",
  );

  // ============================================================================
  // HEALTH & CORE
  // ============================================================================
  console.log(
    "\n── HEALTH & CORE ──────────────────────────────────────────────\n",
  );

  await testEndpoint("CORE", "/api/health");
  // Note: /api/health/full doesn't exist - only /api/health

  // ============================================================================
  // AUTH ENDPOINTS
  // ============================================================================
  console.log(
    "\n── AUTH ENDPOINTS ─────────────────────────────────────────────\n",
  );

  await testEndpoint("AUTH", "/api/auth/login", {
    method: "POST",
    expectedStatus: [400, 401],
    body: {},
  });
  await testEndpoint("AUTH", "/api/auth/signup", {
    method: "POST",
    expectedStatus: [400, 422],
    body: {},
  });
  await testEndpoint("AUTH", "/api/auth/me", {
    expectedStatus: [401],
    requiresAuth: true,
  });

  // ============================================================================
  // SERVICES (PUBLIC)
  // ============================================================================
  console.log(
    "\n── SERVICES (PUBLIC) ──────────────────────────────────────────\n",
  );

  const servicesRes = await testEndpoint("SERVICES", "/api/services");
  await testEndpoint("SERVICES", "/api/services/deals");
  await testEndpoint("SERVICES", "/api/services/workspace");

  // If services exist, test detail endpoint
  if (servicesRes?.data?.services?.[0]?._id) {
    await testEndpoint(
      "SERVICES",
      `/api/services/${servicesRes.data.services[0]._id}`,
    );
    await testEndpoint(
      "SERVICES",
      `/api/services/${servicesRes.data.services[0]._id}/actions`,
    );
  }

  // ============================================================================
  // ORDERS (AUTH REQUIRED)
  // ============================================================================
  console.log(
    "\n── ORDERS (AUTH REQUIRED) ─────────────────────────────────────\n",
  );

  await testEndpoint("ORDERS", "/api/orders", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ORDERS", "/api/orders/my", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ORDERS", "/api/orders", {
    method: "POST",
    expectedStatus: [401],
    requiresAuth: true,
    body: {},
  });
  await testEndpoint("ORDERS", "/api/orders/deal", {
    method: "POST",
    expectedStatus: [401],
    requiresAuth: true,
    body: {},
  });

  // ============================================================================
  // RENTALS
  // ============================================================================
  console.log(
    "\n── RENTALS ────────────────────────────────────────────────────\n",
  );

  await testEndpoint("RENTALS", "/api/rentals");
  await testEndpoint("RENTALS", "/api/rentals/my", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("RENTALS", "/api/rentals/create", {
    method: "POST",
    expectedStatus: [401],
    requiresAuth: true,
    body: {},
  });

  // ============================================================================
  // WORKSPACE
  // ============================================================================
  console.log(
    "\n── WORKSPACE ──────────────────────────────────────────────────\n",
  );

  await testEndpoint("WORKSPACE", "/api/workspace/profile", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("WORKSPACE", "/api/workspace/screenings", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("WORKSPACE", "/api/workspace/projects", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("WORKSPACE", "/api/workspace/earnings", {
    expectedStatus: [401],
    requiresAuth: true,
  });

  // ============================================================================
  // WORK POSITIONS (PUBLIC)
  // ============================================================================
  console.log(
    "\n── WORK POSITIONS (PUBLIC) ────────────────────────────────────\n",
  );

  await testEndpoint("WORK", "/api/work-positions");
  await testEndpoint("WORK", "/api/apply-work", {
    expectedStatus: [401, 404],
    requiresAuth: true,
  });

  // ============================================================================
  // ADMIN ENDPOINTS
  // ============================================================================
  console.log(
    "\n── ADMIN ENDPOINTS ────────────────────────────────────────────\n",
  );

  await testEndpoint("ADMIN", "/api/admin/services", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ADMIN", "/api/admin/orders", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ADMIN", "/api/admin/rentals", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ADMIN", "/api/admin/workspace", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("ADMIN", "/api/admin/analytics", {
    expectedStatus: [401],
    requiresAuth: true,
  });

  // ============================================================================
  // JARVISX
  // ============================================================================
  console.log(
    "\n── JARVISX ────────────────────────────────────────────────────\n",
  );

  await testEndpoint("JARVISX", "/api/jarvisx/chat", {
    method: "POST",
    expectedStatus: [200, 400, 401], // 200 is valid response, 400 if body missing, 401 if auth required
    body: { message: "test" },
  });
  await testEndpoint("JARVISX", "/api/jarvisx/write/execute", {
    method: "POST",
    expectedStatus: [400, 401, 403],
    requiresAuth: true,
    body: { action: "test" },
  });

  // ============================================================================
  // PAYMENT
  // ============================================================================
  console.log(
    "\n── PAYMENT ────────────────────────────────────────────────────\n",
  );

  await testEndpoint("PAYMENT", "/api/payment");
  await testEndpoint("PAYMENT", "/api/payment-methods", {
    expectedStatus: [401, 200],
  });

  // ============================================================================
  // WALLET
  // ============================================================================
  console.log(
    "\n── WALLET ─────────────────────────────────────────────────────\n",
  );

  await testEndpoint("WALLET", "/api/wallet", {
    expectedStatus: [401],
    requiresAuth: true,
  });
  await testEndpoint("WALLET", "/api/wallet/transactions", {
    expectedStatus: [401],
    requiresAuth: true,
  });

  // ============================================================================
  // FINAL REPORT
  // ============================================================================
  console.log(
    "\n╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                      VALIDATION REPORT                        ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(
    `║  Total Endpoints Tested: ${String(results.passes + results.fails).padEnd(35)}║`,
  );
  console.log(`║  Passes: ${String(results.passes).padEnd(51)}║`);
  console.log(`║  Fails:  ${String(results.fails).padEnd(51)}║`);
  console.log(
    `║  Final Result: ${(results.fails === 0 ? "✅ ALL ENDPOINTS EXIST" : "❌ MISSING ENDPOINTS").padEnd(45)}║`,
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝\n",
  );

  // Missing endpoints summary
  const failedEndpoints = results.endpoints.filter((e) => e.result === "FAIL");
  if (failedEndpoints.length > 0) {
    console.log("\n🐛 MISSING/BROKEN ENDPOINTS:");
    failedEndpoints.forEach((e, i) => {
      console.log(`   ${i + 1}. [${e.category}] ${e.endpoint}: ${e.details}`);
    });
  }

  // Output JSON
  console.log("\n📊 JSON Results:");
  console.log(
    JSON.stringify(
      {
        passes: results.passes,
        fails: results.fails,
        status: results.fails === 0 ? "PASS" : "FAIL",
        missingEndpoints: failedEndpoints.map((e) => e.endpoint),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main().catch(console.error);
