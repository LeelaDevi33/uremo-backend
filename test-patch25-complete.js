const { baseUrl, testCredentials } = require("./scripts/test-target");
const { email: ADMIN_EMAIL, password: ADMIN_PASS } = testCredentials("ADMIN");
/**
 * PATCH_25 Complete Test Suite
 * Tests ALL platform functionality after audit fixes
 */

const axios = require("axios").create({ maxRedirects: 0 });
const fs = require("fs");
const path = require("path");

const BASE = baseUrl + "/api";

const results = [];
let passed = 0;
let failed = 0;
let warnings = 0;

function log(msg) {
  console.log(msg);
  results.push(msg);
}

function pass(name) {
  passed++;
  log(`✅ PASS: ${name}`);
}

function fail(name, reason) {
  failed++;
  log(`❌ FAIL: ${name} - ${reason}`);
}

function warn(name, reason) {
  warnings++;
  log(`⚠️  WARN: ${name} - ${reason}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  log("═══════════════════════════════════════════════════════════════");
  log("UREMO FULL PLATFORM TEST SUITE - PATCH_25");
  log("Date: " + new Date().toISOString());
  log("Backend: " + BASE);
  log("═══════════════════════════════════════════════════════════════\n");

  let adminToken = null;
  let userToken = null;
  let testUserId = null;
  let testServiceId = null;
  let testOrderId = null;

  // ══════════════════════════════════════════════════════════════════
  // SECTION 1: AUTHENTICATION
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 1: AUTHENTICATION ───\n");

  // Test 1.1: Health Check
  try {
    const res = await axios.get(BASE + "/health");
    if (res.data.status === "ok") {
      pass("Health Check");
    } else {
      fail("Health Check", "Unexpected response");
    }
  } catch (e) {
    fail("Health Check", e.message);
  }

  // Test 1.2: Admin Login
  try {
    const res = await axios.post(BASE + "/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASS,
    });
    if (res.data.token) {
      adminToken = res.data.token;
      pass("Admin Login");
    } else {
      fail("Admin Login", "No token returned");
    }
  } catch (e) {
    fail("Admin Login", e.response?.data?.message || e.message);
  }

  // Test 1.3: User Signup with Referral Code
  const testEmail = `test${Date.now()}@uremo-test.com`;
  try {
    // First get admin's referral code
    const profileRes = await axios.get(BASE + "/auth/me", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const adminRefCode = profileRes.data.user.referralCode;
    log(`   Admin referral code: ${adminRefCode}`);

    const signupRes = await axios.post(BASE + "/auth/signup", {
      name: "Test User PATCH25",
      email: testEmail,
      password: "testpass123",
      referralCode: adminRefCode,
    });

    if (signupRes.data.token) {
      userToken = signupRes.data.token;
      testUserId = signupRes.data.user.id;

      // Check if referredBy is returned (PATCH_25 fix)
      if (signupRes.data.user.referredBy) {
        pass("User Signup with Referral (referredBy returned)");
      } else {
        warn(
          "User Signup with Referral",
          "referredBy not in response - PATCH_25 not deployed yet",
        );
      }
    } else {
      fail("User Signup", "No token returned");
    }
  } catch (e) {
    fail("User Signup", e.response?.data?.message || e.message);
  }

  // Test 1.4: User Login
  try {
    const res = await axios.post(BASE + "/auth/login", {
      email: testEmail,
      password: "testpass123",
    });
    if (res.data.token) {
      userToken = res.data.token;
      pass("User Login");
    } else {
      fail("User Login", "No token returned");
    }
  } catch (e) {
    fail("User Login", e.response?.data?.message || e.message);
  }

  // Test 1.5: Get User Profile
  try {
    const res = await axios.get(BASE + "/auth/me", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (res.data.user && res.data.user.email) {
      pass("Get User Profile (/auth/me)");
    } else {
      fail("Get User Profile", "Invalid response");
    }
  } catch (e) {
    fail("Get User Profile", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 2: SERVICES (User Side)
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 2: SERVICES ───\n");

  // Test 2.1: Browse Services (Public)
  try {
    const res = await axios.get(BASE + "/services");
    if (Array.isArray(res.data.services) && res.data.services.length > 0) {
      testServiceId = res.data.services[0]._id;
      pass(`Browse Services (${res.data.services.length} found)`);
    } else {
      warn("Browse Services", "No services in database");
    }
  } catch (e) {
    fail("Browse Services", e.response?.data?.message || e.message);
  }

  // Test 2.2: Get Single Service
  if (testServiceId) {
    try {
      const res = await axios.get(BASE + "/services/" + testServiceId);
      if (res.data.service || res.data._id) {
        pass("Get Single Service");
      } else {
        fail("Get Single Service", "Invalid response");
      }
    } catch (e) {
      fail("Get Single Service", e.response?.data?.message || e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 3: WALLET
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 3: WALLET ───\n");

  // Test 3.1: Get Wallet Balance
  try {
    const res = await axios.get(BASE + "/wallet/balance", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (
      typeof res.data.balance === "number" ||
      res.data.walletBalance !== undefined
    ) {
      pass("Get Wallet Balance");
    } else {
      fail("Get Wallet Balance", "Invalid response");
    }
  } catch (e) {
    fail("Get Wallet Balance", e.response?.data?.message || e.message);
  }

  // Test 3.2: Get Wallet Transactions
  try {
    const res = await axios.get(BASE + "/wallet/transactions", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (Array.isArray(res.data.transactions) || Array.isArray(res.data)) {
      pass("Get Wallet Transactions");
    } else {
      fail("Get Wallet Transactions", "Invalid response");
    }
  } catch (e) {
    fail("Get Wallet Transactions", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 4: AFFILIATE
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 4: AFFILIATE ───\n");

  // Test 4.1: Get Affiliate Stats
  try {
    const res = await axios.get(BASE + "/affiliate/stats", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (res.data) {
      pass("Get Affiliate Stats");
    } else {
      fail("Get Affiliate Stats", "Invalid response");
    }
  } catch (e) {
    if (e.response?.status === 404) {
      warn("Get Affiliate Stats", "Endpoint not found");
    } else {
      fail("Get Affiliate Stats", e.response?.data?.message || e.message);
    }
  }

  // Test 4.2: Get Affiliate Transactions
  try {
    const res = await axios.get(BASE + "/affiliate/transactions", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (Array.isArray(res.data.transactions) || Array.isArray(res.data)) {
      pass("Get Affiliate Transactions");
    } else {
      fail("Get Affiliate Transactions", "Invalid response");
    }
  } catch (e) {
    if (e.response?.status === 404) {
      warn("Get Affiliate Transactions", "Endpoint not found");
    } else {
      fail(
        "Get Affiliate Transactions",
        e.response?.data?.message || e.message,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 5: ORDERS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 5: ORDERS ───\n");

  // Test 5.1: Get User Orders
  try {
    const res = await axios.get(BASE + "/orders", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (Array.isArray(res.data.orders) || Array.isArray(res.data)) {
      pass("Get User Orders");
    } else {
      fail("Get User Orders", "Invalid response");
    }
  } catch (e) {
    fail("Get User Orders", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 6: RENTALS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 6: RENTALS ───\n");

  // Test 6.1: Get User Rentals
  try {
    const res = await axios.get(BASE + "/rentals", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (Array.isArray(res.data.rentals) || Array.isArray(res.data)) {
      pass("Get User Rentals");
    } else {
      fail("Get User Rentals", "Invalid response");
    }
  } catch (e) {
    fail("Get User Rentals", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 7: TICKETS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 7: TICKETS ───\n");

  // Test 7.1: Get User Tickets
  try {
    const res = await axios.get(BASE + "/tickets", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (Array.isArray(res.data.tickets) || Array.isArray(res.data)) {
      pass("Get User Tickets");
    } else {
      fail("Get User Tickets", "Invalid response");
    }
  } catch (e) {
    fail("Get User Tickets", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 8: BLOGS (Public)
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 8: BLOGS ───\n");

  // Test 8.1: Get Public Blogs
  try {
    const res = await axios.get(BASE + "/blogs");
    if (Array.isArray(res.data.blogs) || Array.isArray(res.data)) {
      pass("Get Public Blogs");
    } else {
      fail("Get Public Blogs", "Invalid response");
    }
  } catch (e) {
    fail("Get Public Blogs", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 9: ADMIN - SERVICES CRUD
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 9: ADMIN SERVICES ───\n");

  let createdServiceId = null;

  // Test 9.1: Admin Get All Services
  try {
    const res = await axios.get(BASE + "/admin/services", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.services) || Array.isArray(res.data)) {
      pass("Admin Get All Services");
    } else {
      fail("Admin Get All Services", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Services", e.response?.data?.message || e.message);
  }

  // Test 9.2: Admin Create Service
  try {
    const res = await axios.post(
      BASE + "/admin/services",
      {
        title: "Test Service PATCH25 " + Date.now(),
        description: "Automated test service for PATCH_25 verification",
        category: "plumber",
        price: 99.99,
        active: true,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    if (res.data.service || res.data._id) {
      createdServiceId = res.data.service?._id || res.data._id;
      pass("Admin Create Service");
    } else {
      fail("Admin Create Service", "Invalid response");
    }
  } catch (e) {
    fail("Admin Create Service", e.response?.data?.message || e.message);
  }

  // Test 9.3: Admin Update Service
  if (createdServiceId) {
    try {
      const res = await axios.put(
        BASE + "/admin/services/" + createdServiceId,
        { price: 149.99 },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (res.data.service || res.data._id || res.status === 200) {
        pass("Admin Update Service");
      } else {
        fail("Admin Update Service", "Invalid response");
      }
    } catch (e) {
      fail("Admin Update Service", e.response?.data?.message || e.message);
    }
  }

  // Test 9.4: Admin Delete Service
  if (createdServiceId) {
    try {
      const res = await axios.delete(
        BASE + "/admin/services/" + createdServiceId,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      if (res.status === 200 || res.status === 204) {
        pass("Admin Delete Service");
      } else {
        fail("Admin Delete Service", "Unexpected status: " + res.status);
      }
    } catch (e) {
      fail("Admin Delete Service", e.response?.data?.message || e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 10: ADMIN - BLOGS CRUD
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 10: ADMIN BLOGS ───\n");

  let createdBlogId = null;

  // Test 10.1: Admin Create Blog
  try {
    const res = await axios.post(
      BASE + "/admin/blogs",
      {
        title: "Test Blog PATCH25 " + Date.now(),
        content:
          "This is automated test content for PATCH_25 verification. It needs to be long enough to pass validation.",
        category: "general",
        status: "draft",
      },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    if (res.data.blog || res.data._id) {
      createdBlogId = res.data.blog?._id || res.data._id;
      pass("Admin Create Blog");
    } else {
      fail("Admin Create Blog", "Invalid response");
    }
  } catch (e) {
    fail("Admin Create Blog", e.response?.data?.message || e.message);
  }

  // Test 10.2: Admin Get All Blogs
  try {
    const res = await axios.get(BASE + "/admin/blogs", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.blogs) || Array.isArray(res.data)) {
      pass("Admin Get All Blogs");
    } else {
      fail("Admin Get All Blogs", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Blogs", e.response?.data?.message || e.message);
  }

  // Test 10.3: Admin Delete Blog
  if (createdBlogId) {
    try {
      const res = await axios.delete(BASE + "/admin/blogs/" + createdBlogId, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 200 || res.status === 204) {
        pass("Admin Delete Blog");
      } else {
        fail("Admin Delete Blog", "Unexpected status: " + res.status);
      }
    } catch (e) {
      fail("Admin Delete Blog", e.response?.data?.message || e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 11: ADMIN - ORDERS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 11: ADMIN ORDERS ───\n");

  // Test 11.1: Admin Get All Orders
  try {
    const res = await axios.get(BASE + "/admin/orders", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.orders) || Array.isArray(res.data)) {
      pass("Admin Get All Orders");
    } else {
      fail("Admin Get All Orders", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Orders", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 12: ADMIN - WALLET
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 12: ADMIN WALLET ───\n");

  // Test 12.1: Admin Get All Users with Wallet
  try {
    const res = await axios.get(BASE + "/admin/wallet/users", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.users) || Array.isArray(res.data)) {
      pass("Admin Get Wallet Users");
    } else {
      fail("Admin Get Wallet Users", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get Wallet Users", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 13: ADMIN - AFFILIATES
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 13: ADMIN AFFILIATES ───\n");

  // Test 13.1: Admin Get All Affiliates
  try {
    const res = await axios.get(BASE + "/admin/affiliate/affiliates", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.affiliates) || Array.isArray(res.data)) {
      pass("Admin Get All Affiliates");
    } else {
      fail("Admin Get All Affiliates", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Affiliates", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 14: ADMIN - RENTALS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 14: ADMIN RENTALS ───\n");

  // Test 14.1: Admin Get All Rentals
  try {
    const res = await axios.get(BASE + "/admin/rentals", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.rentals) || Array.isArray(res.data)) {
      pass("Admin Get All Rentals");
    } else {
      fail("Admin Get All Rentals", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Rentals", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 15: ADMIN - TICKETS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 15: ADMIN TICKETS ───\n");

  // Test 15.1: Admin Get All Tickets
  try {
    const res = await axios.get(BASE + "/admin/tickets", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (Array.isArray(res.data.tickets) || Array.isArray(res.data)) {
      pass("Admin Get All Tickets");
    } else {
      fail("Admin Get All Tickets", "Invalid response");
    }
  } catch (e) {
    fail("Admin Get All Tickets", e.response?.data?.message || e.message);
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 16: SECURITY TESTS
  // ══════════════════════════════════════════════════════════════════
  log("\n─── SECTION 16: SECURITY ───\n");

  // Test 16.1: Admin route without token
  try {
    await axios.get(BASE + "/admin/services");
    fail("Admin Route Security", "Should have returned 401");
  } catch (e) {
    if (e.response?.status === 401) {
      pass("Admin Route Security (No Token = 401)");
    } else {
      fail("Admin Route Security", "Expected 401, got " + e.response?.status);
    }
  }

  // Test 16.2: Admin route with user token
  try {
    await axios.get(BASE + "/admin/services", {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    fail("Admin Route User Access", "Should have returned 403");
  } catch (e) {
    if (e.response?.status === 403) {
      pass("Admin Route Security (User = 403)");
    } else if (e.response?.status === 401) {
      pass("Admin Route Security (User = 401)");
    } else {
      fail(
        "Admin Route User Access",
        "Expected 403, got " + e.response?.status,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════════════════
  log("\n═══════════════════════════════════════════════════════════════");
  log("FINAL RESULTS");
  log("═══════════════════════════════════════════════════════════════");
  log(`✅ PASSED:   ${passed}`);
  log(`❌ FAILED:   ${failed}`);
  log(`⚠️  WARNINGS: ${warnings}`);
  log(`📊 TOTAL:    ${passed + failed + warnings}`);
  log(`📈 SUCCESS:  ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  log("═══════════════════════════════════════════════════════════════\n");

  // Write results to file
  const outputPath = path.join(__dirname, "test-results-patch25.txt");
  fs.writeFileSync(outputPath, results.join("\n"));
  console.log("Results written to:", outputPath);

  return { passed, failed, warnings };
}

runTests()
  .then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("Test runner error:", e);
    process.exit(1);
  });
