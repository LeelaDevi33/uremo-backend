/**
 * PATCH_21 Admin Flow Tests
 * Tests: Login, Create Services, Edit Service, JarvisX Admin Commands
 */

const { baseUrl: BASE_URL, email, password, testFetch } = require("./admin-test-config");

let authToken = null;
let createdServiceIds = [];

async function request(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = { method, headers };
  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await testFetch(`${BASE_URL}${path}`, options);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

function log(label, result) {
  const icon = result.ok ? "✅" : "❌";
  console.log(`\n${icon} ${label}`);
  console.log(`   Status: ${result.status}`);
  if (result.error) console.log(`   Error: ${result.error}`);
  if (result.data?.message) console.log(`   Message: ${result.data.message}`);
  if (result.data?.ok !== undefined) console.log(`   OK: ${result.data.ok}`);
  return result;
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("🧪 PATCH_21 ADMIN FLOW TESTS");
  console.log("=".repeat(60));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  // ═══════════════════════════════════════════════════════════════
  // 1. ADMIN LOGIN
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 1: ADMIN LOGIN");
  console.log("-".repeat(40));

  const loginRes = await request("POST", "/api/auth/login", {
    email,
    password,
  });

  log("Admin Login", loginRes);

  if (!loginRes.ok || !loginRes.data?.token) {
    console.error("❌ FATAL: Cannot login as admin. Exiting.");
    console.log("Response:", JSON.stringify(loginRes.data, null, 2));
    return;
  }

  authToken = loginRes.data.token;

  console.log(`   User Role: ${loginRes.data.user?.role || "N/A"}`);

  if (loginRes.data.user?.role !== "admin") {
    console.error("⚠️ WARNING: User may not have admin role!");
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. CREATE SERVICE: MICROJOBS FRESH ACCOUNT
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 2: CREATE SERVICE - MICROJOBS FRESH");
  console.log("-".repeat(40));

  const microjobService = {
    title: "Outlier AI Expert - Math Subject (Test PATCH_21)",
    category: "microjobs",
    subcategory: "fresh_account",
    description:
      "Get help applying to Outlier AI for Math expert positions. We assist with application, profile setup, and assessment preparation.",
    shortDescription: "Outlier AI Math expert application assistance",
    price: 35,
    currency: "USD",
    deliveryType: "manual",
    platform: "Outlier",
    subject: "Math",
    countries: ["India", "USA", "UK", "Global"],
    status: "active",
  };

  const createMicrojobRes = await request(
    "POST",
    "/api/admin/services",
    microjobService,
    authToken,
  );
  log("Create Microjobs Service", createMicrojobRes);

  if (createMicrojobRes.ok && createMicrojobRes.data?.service?._id) {
    createdServiceIds.push(createMicrojobRes.data.service._id);
    console.log(`   Service ID: ${createMicrojobRes.data.service._id}`);
    console.log(`   Slug: ${createMicrojobRes.data.service.slug}`);
  } else {
    console.log(
      "   Full Response:",
      JSON.stringify(createMicrojobRes.data, null, 2),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. CREATE SERVICE: FOREX
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 3: CREATE SERVICE - FOREX");
  console.log("-".repeat(40));

  const forexService = {
    title: "Bybit KYC Verified Account (Test PATCH_21)",
    category: "forex_crypto",
    subcategory: "crypto_platform_creation",
    description:
      "Get a fully KYC verified Bybit trading account. Ready to trade crypto with high limits and full features enabled.",
    shortDescription: "Bybit verified account for crypto trading",
    price: 45,
    currency: "USD",
    deliveryType: "instant",
    platform: "Bybit",
    countries: ["India", "UAE", "Pakistan"],
    countryPricing: { India: 40, UAE: 50, Pakistan: 38 },
    status: "active",
  };

  const createForexRes = await request(
    "POST",
    "/api/admin/services",
    forexService,
    authToken,
  );
  log("Create Forex/Crypto Service", createForexRes);

  if (createForexRes.ok && createForexRes.data?.service?._id) {
    createdServiceIds.push(createForexRes.data.service._id);
    console.log(`   Service ID: ${createForexRes.data.service._id}`);
    console.log(`   Slug: ${createForexRes.data.service.slug}`);
  } else {
    console.log(
      "   Full Response:",
      JSON.stringify(createForexRes.data, null, 2),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. CREATE SERVICE: BANKS/WALLETS
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 4: CREATE SERVICE - BANKS/WALLETS");
  console.log("-".repeat(40));

  const bankService = {
    title: "PayPal Business Verified (Test PATCH_21)",
    category: "banks_gateways_wallets",
    subcategory: "payment_gateways",
    description:
      "Fully verified PayPal Business account with bank linked. Ready for receiving payments internationally.",
    shortDescription: "PayPal Business account verified and ready",
    price: 75,
    currency: "USD",
    deliveryType: "manual",
    platform: "PayPal",
    countries: ["USA", "UK", "Canada", "Global"],
    status: "active",
  };

  const createBankRes = await request(
    "POST",
    "/api/admin/services",
    bankService,
    authToken,
  );
  log("Create Banks/Wallets Service", createBankRes);

  if (createBankRes.ok && createBankRes.data?.service?._id) {
    createdServiceIds.push(createBankRes.data.service._id);
    console.log(`   Service ID: ${createBankRes.data.service._id}`);
    console.log(`   Slug: ${createBankRes.data.service.slug}`);
  } else {
    console.log(
      "   Full Response:",
      JSON.stringify(createBankRes.data, null, 2),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. EDIT EXISTING SERVICE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 5: EDIT EXISTING SERVICE");
  console.log("-".repeat(40));

  // First get list of services
  const listRes = await request("GET", "/api/admin/services", null, authToken);

  if (!listRes.ok) {
    console.log("❌ Could not fetch services list");
    console.log("   Response:", JSON.stringify(listRes.data, null, 2));
  } else {
    const services = Array.isArray(listRes.data)
      ? listRes.data
      : listRes.data?.services || [];
    console.log(`   Found ${services.length} services`);

    if (services.length > 0) {
      const serviceToEdit = services[0];
      console.log(
        `   Editing: "${serviceToEdit.title}" (${serviceToEdit._id})`,
      );

      const updateData = {
        shortDescription: `Updated at ${new Date().toISOString()} - PATCH_21 test`,
        price: serviceToEdit.price + 1, // Increase price by $1 as test
      };

      const editRes = await request(
        "PUT",
        `/api/admin/services/${serviceToEdit._id}`,
        updateData,
        authToken,
      );
      log("Edit Service", editRes);

      if (editRes.ok) {
        console.log(`   New Price: $${editRes.data?.service?.price || "N/A"}`);
        console.log(
          `   Updated At: ${editRes.data?.service?.updatedAt || "N/A"}`,
        );
      } else {
        console.log("   Full Response:", JSON.stringify(editRes.data, null, 2));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. TEST JARVISX ADMIN WRITE MODE (Create Service via Chat)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 6: JARVISX ADMIN WRITE MODE");
  console.log("-".repeat(40));

  // Test if JarvisX can create a service when commanded by admin
  const jarvisWriteTest = await request(
    "POST",
    "/api/jarvisx/chat",
    {
      message:
        "Create a new service: title 'Scale AI Data Labeler Support', category microjobs, subcategory fresh_account, price $25, platform Scale AI, subject Data Labeling, countries India and USA, description 'Expert help for Scale AI tasker application and onboarding'",
    },
    authToken,
  );

  log("JarvisX Write Mode (Create Service Command)", jarvisWriteTest);
  console.log(`   Intent: ${jarvisWriteTest.data?.intent || "N/A"}`);
  console.log(
    `   Reply: ${(jarvisWriteTest.data?.reply || "").substring(0, 200)}...`,
  );
  console.log(
    `   Quick Replies: ${JSON.stringify(jarvisWriteTest.data?.quickReplies || [])}`,
  );

  // Check if service was created
  if (jarvisWriteTest.data?.service?._id) {
    createdServiceIds.push(jarvisWriteTest.data.service._id);
    console.log(
      `   ✅ Service Created via JarvisX: ${jarvisWriteTest.data.service._id}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. TEST JARVISX ADMIN CHAT MODE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 7: JARVISX ADMIN CHAT MODE");
  console.log("-".repeat(40));

  // Test various admin chat commands
  const adminChatTests = [
    { msg: "show me all services", desc: "List Services" },
    { msg: "how many orders today?", desc: "Orders Query" },
    { msg: "what's the system status?", desc: "System Status" },
    { msg: "help me create a service", desc: "Create Service Flow" },
  ];

  for (const test of adminChatTests) {
    const chatRes = await request(
      "POST",
      "/api/jarvisx/chat",
      { message: test.msg },
      authToken,
    );
    console.log(`\n   🗣️ "${test.msg}"`);
    console.log(`   ${chatRes.ok ? "✅" : "❌"} ${test.desc}`);
    console.log(`   Intent: ${chatRes.data?.intent || "N/A"}`);
    console.log(
      `   Reply: ${(chatRes.data?.reply || "").substring(0, 150)}...`,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. VERIFY CREATED SERVICES IN PUBLIC API
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n📌 STEP 8: VERIFY IN PUBLIC API");
  console.log("-".repeat(40));

  const publicRes = await request("GET", "/api/services");

  if (publicRes.ok) {
    const services = Array.isArray(publicRes.data)
      ? publicRes.data
      : publicRes.data?.services || [];
    console.log(`   Total Public Services: ${services.length}`);

    // Check for our created services
    for (const id of createdServiceIds) {
      const found = services.find((s) => s._id === id);
      if (found) {
        console.log(
          `   ✅ Found: "${found.title}" (${found.category}/${found.subcategory})`,
        );
      } else {
        console.log(`   ⚠️ Not found in public API: ${id}`);
      }
    }

    // Check filters
    const filters = publicRes.data?.filters;
    if (filters?.categories) {
      console.log(
        `   Categories: ${filters.categories.map((c) => c.id).join(", ")}`,
      );
      const hasRentals = filters.categories.some((c) => c.id === "rentals");
      console.log(`   Has "rentals" category: ${hasRentals ? "✅" : "❌"}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n\n" + "=".repeat(60));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Created Services: ${createdServiceIds.length}`);
  createdServiceIds.forEach((id, i) => console.log(`   ${i + 1}. ${id}`));
  console.log("\n🏁 Tests completed!");
  console.log("=".repeat(60));
}

runTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
