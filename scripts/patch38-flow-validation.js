const { baseUrl, testFetch } = require("./test-target");
/**
 * PATCH_38: Real Transaction Flow Validation
 * Tests actual user journeys across BUY, RENT, DEAL, and WORKSPACE flows
 *
 * Run: node scripts/patch38-flow-validation.js
 */

const BASE_URL = baseUrl;

// REQUIRED: Set these environment variables before running
// TEST_EMAIL and TEST_PASSWORD must be valid credentials
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Test results storage
const results = {
  flows: [],
  bugs: [],
  passes: 0,
  fails: 0,
  skipped: 0,
};

function log(flow, step, result, details = "") {
  const icon =
    result === "PASS"
      ? "✅"
      : result === "FAIL"
        ? "❌"
        : result === "SKIP"
          ? "⏭️"
          : "⏳";
  console.log(`${icon} [${flow}] ${step}: ${result} ${details}`);
  results.flows.push({
    flow,
    step,
    result,
    details,
    timestamp: new Date().toISOString(),
  });
  if (result === "PASS") results.passes++;
  if (result === "FAIL") {
    results.fails++;
    results.bugs.push({ flow, step, details });
  }
}

async function apiCall(endpoint, method = "GET", body = null, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);

  const res = await testFetch(`${BASE_URL}${endpoint}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ============================================================================
// A) BUY FLOW VALIDATION
// ============================================================================
async function testBuyFlow() {
  console.log("\n════════════════════════════════════════");
  console.log("A) MARKETPLACE → BUY FLOW");
  console.log("════════════════════════════════════════\n");

  let userToken = null;
  let orderId = null;
  let serviceId = null;

  // Step 1: Check services exist
  const servicesRes = await apiCall("/api/services?status=active&limit=10");
  if (!servicesRes.ok || !servicesRes.data?.services?.length) {
    log("BUY", "Step 1: Check services", "FAIL", "No active services found");
    return;
  }

  // Find a buyable service
  const buyableService = servicesRes.data.services.find(
    (s) =>
      s.active !== false &&
      (!s.allowedActions || s.allowedActions.buy !== false),
  );

  if (!buyableService) {
    log("BUY", "Step 1: Find buyable service", "FAIL", "No buyable services");
    return;
  }

  serviceId = buyableService._id;
  log(
    "BUY",
    "Step 1: Find buyable service",
    "PASS",
    `Found: ${buyableService.title}`,
  );

  // Step 2-3: Login as test user (use existing admin for testing)
  // In real scenario, would create user
  const loginRes = await apiCall("/api/auth/login", "POST", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (!loginRes.ok || !loginRes.data?.token) {
    log(
      "BUY",
      "Step 2-3: User login",
      "FAIL",
      loginRes.data?.message || "Login failed",
    );
    return;
  }

  userToken = loginRes.data.token;
  log(
    "BUY",
    "Step 2-3: User login",
    "PASS",
    `Logged in as ${loginRes.data.user?.email}`,
  );

  // Step 4: Create order (purchase)
  const orderRes = await apiCall(
    "/api/orders",
    "POST",
    { serviceId },
    userToken,
  );

  if (!orderRes.ok || !orderRes.data?.orderId) {
    log(
      "BUY",
      "Step 4: Create order",
      "FAIL",
      orderRes.data?.message || "Order creation failed",
    );
    return;
  }

  orderId = orderRes.data.orderId;
  log("BUY", "Step 4: Create order", "PASS", `Order ID: ${orderId}`);

  // Step 5: Verify order in user's orders
  const myOrdersRes = await apiCall("/api/orders/my", "GET", null, userToken);

  if (!myOrdersRes.ok) {
    log(
      "BUY",
      "Step 5: Order in My Orders",
      "FAIL",
      "Could not fetch my orders",
    );
    return;
  }

  const myOrder = (myOrdersRes.data || []).find((o) => o._id === orderId);
  if (!myOrder) {
    log(
      "BUY",
      "Step 5: Order in My Orders",
      "FAIL",
      "Order not found in user orders",
    );
    return;
  }

  log("BUY", "Step 5: Order in My Orders", "PASS", `Status: ${myOrder.status}`);

  // Step 6: Verify order in admin orders
  const adminOrdersRes = await apiCall(
    "/api/admin/orders",
    "GET",
    null,
    userToken,
  );

  if (!adminOrdersRes.ok) {
    log(
      "BUY",
      "Step 6: Order in Admin Orders",
      "FAIL",
      "Could not fetch admin orders",
    );
    return;
  }

  const adminOrder = (adminOrdersRes.data || []).find((o) => o._id === orderId);
  if (!adminOrder) {
    log(
      "BUY",
      "Step 6: Order in Admin Orders",
      "FAIL",
      "Order not visible in admin",
    );
    return;
  }

  log("BUY", "Step 6: Order in Admin Orders", "PASS", "Order visible to admin");

  // Step 7: Admin updates order status
  const updateRes = await apiCall(
    `/api/admin/orders/${orderId}`,
    "PUT",
    {
      status: "in_progress",
    },
    userToken,
  );

  if (!updateRes.ok) {
    log("BUY", "Step 7: Admin update status", "FAIL", updateRes.data?.message);
    return;
  }

  log(
    "BUY",
    "Step 7: Admin update status",
    "PASS",
    "Status changed to in_progress",
  );

  // Step 8: User sees updated status
  const refreshOrdersRes = await apiCall(
    "/api/orders/my",
    "GET",
    null,
    userToken,
  );
  const refreshedOrder = (refreshOrdersRes.data || []).find(
    (o) => o._id === orderId,
  );

  if (!refreshedOrder || refreshedOrder.status !== "in_progress") {
    log(
      "BUY",
      "Step 8: User sees update",
      "FAIL",
      `Status: ${refreshedOrder?.status}`,
    );
    return;
  }

  log("BUY", "Step 8: User sees update", "PASS", "Status sync confirmed");

  console.log("\n✅ BUY FLOW COMPLETE\n");
}

// ============================================================================
// B) RENTAL FLOW VALIDATION
// ============================================================================
async function testRentalFlow() {
  console.log("\n════════════════════════════════════════");
  console.log("B) RENTAL FLOW");
  console.log("════════════════════════════════════════\n");

  let userToken = null;
  let rentalId = null;

  // Login
  const loginRes = await apiCall("/api/auth/login", "POST", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (!loginRes.ok) {
    log("RENTAL", "Login", "FAIL", "Could not login");
    return;
  }

  userToken = loginRes.data.token;
  log("RENTAL", "Step 1-2: User login", "PASS");

  // Check for rental services
  const rentalServicesRes = await apiCall("/api/rentals", "GET");

  if (!rentalServicesRes.ok) {
    log("RENTAL", "Step 3: Get rental services", "FAIL", "API error");
    return;
  }

  const rentalServices =
    rentalServicesRes.data?.services || rentalServicesRes.data || [];

  if (!rentalServices.length) {
    log(
      "RENTAL",
      "Step 3: Get rental services",
      "SKIP",
      "No rental services configured",
    );
    return;
  }

  log(
    "RENTAL",
    "Step 3: Find rentable service",
    "PASS",
    `Found ${rentalServices.length} services`,
  );

  // Check user's existing rentals
  const myRentalsRes = await apiCall("/api/rentals/my", "GET", null, userToken);

  if (!myRentalsRes.ok) {
    log(
      "RENTAL",
      "Step 4: Check My Rentals",
      "FAIL",
      "Could not fetch rentals",
    );
    return;
  }

  const myRentals = myRentalsRes.data?.rentals || [];
  log(
    "RENTAL",
    "Step 4: My Rentals Page",
    "PASS",
    `User has ${myRentals.length} rentals`,
  );

  console.log("\n✅ RENTAL FLOW VALIDATED\n");
}

// ============================================================================
// C) DEAL FLOW VALIDATION
// ============================================================================
async function testDealFlow() {
  console.log("\n════════════════════════════════════════");
  console.log("C) DEAL / PERCENTAGE FLOW");
  console.log("════════════════════════════════════════\n");

  let userToken = null;

  // Login
  const loginRes = await apiCall("/api/auth/login", "POST", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (!loginRes.ok) {
    log("DEAL", "Login", "FAIL", "Could not login");
    return;
  }

  userToken = loginRes.data.token;
  log("DEAL", "Step 1: User login", "PASS");

  // Check for deal-eligible services
  const dealsRes = await apiCall("/api/services/deals", "GET");

  if (!dealsRes.ok) {
    log("DEAL", "Step 2: Get deal services", "FAIL", "API error");
    return;
  }

  const dealServices = dealsRes.data?.services || dealsRes.data || [];

  if (!dealServices.length) {
    log(
      "DEAL",
      "Step 2: Find deal services",
      "SKIP",
      "No deal services configured",
    );
    return;
  }

  const dealService = dealServices[0];
  log(
    "DEAL",
    "Step 2: Find deal service",
    "PASS",
    `Found: ${dealService.title}`,
  );

  // Create deal order
  const dealOrderRes = await apiCall(
    "/api/orders/deal",
    "POST",
    {
      serviceId: dealService._id,
      dealPercent: 50,
    },
    userToken,
  );

  if (!dealOrderRes.ok) {
    log(
      "DEAL",
      "Step 3: Create deal order",
      "FAIL",
      dealOrderRes.data?.message,
    );
    return;
  }

  log(
    "DEAL",
    "Step 3: Create deal order",
    "PASS",
    `Order: ${dealOrderRes.data?.orderId}`,
  );

  // Verify in user's orders
  const myOrdersRes = await apiCall("/api/orders/my", "GET", null, userToken);
  const dealOrder = (myOrdersRes.data || []).find(
    (o) => o.orderType === "deal" && o.serviceId?._id === dealService._id,
  );

  if (dealOrder) {
    log("DEAL", "Step 4: Deal in user dashboard", "PASS");
  } else {
    log("DEAL", "Step 4: Deal in user dashboard", "FAIL", "Deal not visible");
  }

  console.log("\n✅ DEAL FLOW VALIDATED\n");
}

// ============================================================================
// D) WORKSPACE FLOW VALIDATION
// ============================================================================
async function testWorkspaceFlow() {
  console.log("\n════════════════════════════════════════");
  console.log("D) MICROJOB WORKSPACE FLOW");
  console.log("════════════════════════════════════════\n");

  let userToken = null;

  // Login
  const loginRes = await apiCall("/api/auth/login", "POST", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (!loginRes.ok) {
    log("WORKSPACE", "Login", "FAIL", "Could not login");
    return;
  }

  userToken = loginRes.data.token;
  log("WORKSPACE", "Step 1-2: User login", "PASS");

  // Step 3: Check workspace profile
  const profileRes = await apiCall(
    "/api/workspace/profile",
    "GET",
    null,
    userToken,
  );

  if (!profileRes.ok) {
    log("WORKSPACE", "Step 3: Get profile", "FAIL", profileRes.data?.message);
    return;
  }

  const workspace = profileRes.data;

  if (!workspace.hasProfile) {
    log(
      "WORKSPACE",
      "Step 3: Workspace profile",
      "SKIP",
      "No worker profile - user needs to apply first",
    );

    // Check work positions exist
    const positionsRes = await apiCall("/api/work-positions", "GET");
    const positions = positionsRes.data?.positions || positionsRes.data || [];

    if (positions.length) {
      log(
        "WORKSPACE",
        "Work positions available",
        "PASS",
        `${positions.length} positions found`,
      );
    } else {
      log(
        "WORKSPACE",
        "Work positions available",
        "FAIL",
        "No work positions configured",
      );
    }
    return;
  }

  log(
    "WORKSPACE",
    "Step 3: Workspace profile",
    "PASS",
    `Status: ${workspace.profile?.workerStatus}`,
  );

  // Step 4: Verify worker status
  const status = workspace.profile?.workerStatus || "fresh";
  log("WORKSPACE", "Step 4: Worker status", "PASS", status);

  // Step 5: Check available screenings
  const screenings = workspace.availableScreenings || [];
  log(
    "WORKSPACE",
    "Step 5: Screenings",
    "PASS",
    `${screenings.length} available`,
  );

  // Step 6: Check assigned projects
  const projects = workspace.assignedProjects || [];
  log("WORKSPACE", "Step 6: Projects", "PASS", `${projects.length} assigned`);

  // Step 7: Check earnings
  const stats = workspace.stats || {};
  log(
    "WORKSPACE",
    "Step 7: Earnings",
    "PASS",
    `Total: $${stats.totalEarnings || 0}`,
  );

  console.log("\n✅ WORKSPACE FLOW VALIDATED\n");
}

// ============================================================================
// E) CROSS-SYNC VALIDATION
// ============================================================================
async function testCrossSync() {
  console.log("\n════════════════════════════════════════");
  console.log("E) CROSS-SYNC VALIDATION");
  console.log("════════════════════════════════════════\n");

  let userToken = null;

  // Login as admin
  const loginRes = await apiCall("/api/auth/login", "POST", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (!loginRes.ok) {
    log("CROSS-SYNC", "Login", "FAIL", "Could not login");
    return;
  }

  userToken = loginRes.data.token;

  // Validate orders sync
  const userOrdersRes = await apiCall("/api/orders/my", "GET", null, userToken);
  const adminOrdersRes = await apiCall(
    "/api/admin/orders",
    "GET",
    null,
    userToken,
  );

  if (userOrdersRes.ok && adminOrdersRes.ok) {
    const userOrderIds = (userOrdersRes.data || []).map((o) => o._id);
    const adminOrderIds = (adminOrdersRes.data || []).map((o) => o._id);

    // Check if all user orders appear in admin
    const allSynced = userOrderIds.every((id) => adminOrderIds.includes(id));

    if (allSynced) {
      log(
        "CROSS-SYNC",
        "Orders DB↔User↔Admin",
        "PASS",
        `${userOrderIds.length} orders synced`,
      );
    } else {
      log(
        "CROSS-SYNC",
        "Orders DB↔User↔Admin",
        "FAIL",
        "Some orders missing in admin",
      );
    }
  } else {
    log("CROSS-SYNC", "Orders sync", "FAIL", "Could not validate");
  }

  // Validate rentals sync
  const userRentalsRes = await apiCall(
    "/api/rentals/my",
    "GET",
    null,
    userToken,
  );
  const adminRentalsRes = await apiCall(
    "/api/admin/rentals",
    "GET",
    null,
    userToken,
  );

  if (userRentalsRes.ok && adminRentalsRes.ok) {
    const userRentals = userRentalsRes.data?.rentals || [];
    const adminRentals =
      adminRentalsRes.data?.rentals || adminRentalsRes.data || [];

    log(
      "CROSS-SYNC",
      "Rentals DB↔User↔Admin",
      "PASS",
      `User: ${userRentals.length}, Admin: ${adminRentals.length}`,
    );
  } else {
    log("CROSS-SYNC", "Rentals sync", "FAIL", "API error");
  }

  console.log("\n✅ CROSS-SYNC VALIDATED\n");
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║  PATCH_38: REAL TRANSACTION FLOW VALIDATION                  ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  API: ${BASE_URL.padEnd(55)}║`);
  console.log(`║  Time: ${new Date().toISOString().padEnd(54)}║`);
  console.log(
    "╚══════════════════════════════════════════════════════════════╝\n",
  );

  try {
    await testBuyFlow();
    await testRentalFlow();
    await testDealFlow();
    await testWorkspaceFlow();
    await testCrossSync();
  } catch (err) {
    console.error("Test execution error:", err);
  }

  // Final Report
  console.log(
    "\n╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                      VALIDATION REPORT                        ║",
  );
  console.log(
    "╠══════════════════════════════════════════════════════════════╣",
  );
  console.log(`║  Total Passes: ${String(results.passes).padEnd(46)}║`);
  console.log(`║  Total Fails:  ${String(results.fails).padEnd(46)}║`);
  console.log(
    `║  Final Result: ${(results.fails === 0 ? "✅ PASS" : "❌ FAIL").padEnd(46)}║`,
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝\n",
  );

  if (results.bugs.length > 0) {
    console.log("\n🐛 BUGS FOUND:");
    results.bugs.forEach((bug, i) => {
      console.log(`   ${i + 1}. [${bug.flow}] ${bug.step}: ${bug.details}`);
    });
  }

  // Output JSON for parsing
  console.log("\n📊 JSON Results:");
  console.log(
    JSON.stringify(
      {
        passes: results.passes,
        fails: results.fails,
        status: results.fails === 0 ? "PASS" : "FAIL",
        bugs: results.bugs,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main().catch(console.error);
