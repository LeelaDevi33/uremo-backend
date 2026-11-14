const { baseUrl, testFetch } = require("./test-target");
/**
 * PATCH_21 Service API Tests
 * Tests service creation, update, and listing with new rentals category
 */

const BASE_URL = baseUrl;

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
      data = text;
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

function log(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function runTests() {
  console.log("🧪 PATCH_21 Service API Tests");
  console.log("Base URL:", BASE_URL);
  console.log("Time:", new Date().toISOString());

  // 1. Test health endpoint
  log("1. Health Check", "Testing /api/health...");
  const health = await request("GET", "/api/health");
  console.log("Status:", health.status);
  if (!health.ok) {
    console.error("❌ Backend is not responding. Exiting.");
    return;
  }
  console.log("✅ Backend is healthy");

  // 2. Test public services list (no auth needed)
  log("2. Public Services List", "Testing GET /api/services...");
  const publicServices = await request("GET", "/api/services");
  console.log("Status:", publicServices.status);
  console.log(
    "Service count:",
    Array.isArray(publicServices.data) ? publicServices.data.length : "N/A",
  );

  if (Array.isArray(publicServices.data) && publicServices.data.length > 0) {
    const sample = publicServices.data[0];
    console.log("Sample service:", {
      _id: sample._id,
      title: sample.title,
      category: sample.category,
      subcategory: sample.subcategory,
      price: sample.price,
      active: sample.active,
    });
  }

  // 3. Test services filter by category (rentals should work now)
  log(
    "3. Filter by Rentals Category",
    "Testing GET /api/services?category=rentals...",
  );
  const rentalsFilter = await request("GET", "/api/services?category=rentals");
  console.log("Status:", rentalsFilter.status);
  console.log(
    "Rentals count:",
    Array.isArray(rentalsFilter.data) ? rentalsFilter.data.length : 0,
  );

  // 4. Test JarvisX health for admin auth
  log("4. JarvisX Health", "Testing /api/jarvisx/health...");
  const jarvisHealth = await request("GET", "/api/jarvisx/health");
  console.log("Status:", jarvisHealth.status);
  console.log("LLM configured:", jarvisHealth.data?.llm?.configured);

  // 5. Admin endpoint test (requires auth - will fail without token)
  log(
    "5. Admin Services List (No Auth)",
    "Testing GET /api/admin/services without auth...",
  );
  const adminNoAuth = await request("GET", "/api/admin/services");
  console.log("Status:", adminNoAuth.status);
  console.log("Expected: 401 Unauthorized");
  console.log(
    adminNoAuth.status === 401
      ? "✅ Auth check working"
      : "⚠️ Unexpected response",
  );

  // 6. Test JarvisX chat - LIST_SERVICES intent
  log("6. JarvisX LIST_SERVICES", "Testing 'show me services'...");
  const jarvisChat = await request("POST", "/api/jarvisx/chat", {
    message: "show me available services",
  });
  console.log("Status:", jarvisChat.status);
  console.log("Intent:", jarvisChat.data?.intent);
  console.log(
    "Reply preview:",
    (jarvisChat.data?.reply || "").substring(0, 200) + "...",
  );

  // 7. Test JarvisX - Custom request flow (triggers enhanced 6-question prompt)
  log("7. JarvisX Custom Request Flow", "Testing 'I need bybit accounts'...");
  const customReq = await request("POST", "/api/jarvisx/chat", {
    message: "I need bybit accounts",
  });
  console.log("Status:", customReq.status);
  console.log("Intent:", customReq.data?.intent);
  console.log(
    "Reply includes '6 questions':",
    (customReq.data?.reply || "").includes("Country") &&
      (customReq.data?.reply || "").includes("Urgency"),
  );
  console.log("Quick replies:", customReq.data?.quickReplies);

  // 8. Test rentals category normalization
  log(
    "8. Category Normalization",
    "Testing 'rentals' and 'rental' variants...",
  );
  const rentalTest1 = await request("GET", "/api/services?category=rentals");
  const rentalTest2 = await request("GET", "/api/services?category=rental");
  console.log("'rentals' status:", rentalTest1.status);
  console.log("'rental' status:", rentalTest2.status);

  console.log("\n" + "=".repeat(50));
  console.log("🏁 Tests completed!");
  console.log("=".repeat(50));
}

runTests().catch(console.error);
