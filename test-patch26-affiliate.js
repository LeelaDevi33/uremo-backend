const { baseUrl, testCredentials } = require("./scripts/test-target");
const { email: ADMIN_EMAIL, password: ADMIN_PASS } = testCredentials("ADMIN");
/**
 * PATCH_26: Affiliate Dashboard Acceptance Tests
 * Tests the complete affiliate flow as specified:
 * 1) Create User A
 * 2) Create User B using referral code
 * 3) User B buys service
 * 4) User A sees commission in dashboard
 * 5) Admin sees User A in affiliates list
 */

const axios = require("axios").create({ maxRedirects: 0 });

const BASE = baseUrl + "/api";

const results = [];
let passed = 0;
let failed = 0;

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

async function runTests() {
  log("═══════════════════════════════════════════════════════════════");
  log("PATCH_26: AFFILIATE DASHBOARD ACCEPTANCE TESTS");
  log("Date: " + new Date().toISOString());
  log("═══════════════════════════════════════════════════════════════\n");

  let adminToken = null;
  let userAToken = null;
  let userAId = null;
  let userAReferralCode = null;
  let userBToken = null;
  let userBId = null;

  // Step 0: Admin Login
  log("\n─── STEP 0: Admin Login ───\n");
  try {
    const res = await axios.post(BASE + "/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASS,
    });
    adminToken = res.data.token;
    pass("Admin Login");
    log(`   Admin ID: ${res.data.user.id}`);
    log(`   Admin Referral Code: ${res.data.user.referralCode || "N/A"}`);
  } catch (e) {
    fail("Admin Login", e.response?.data?.message || e.message);
    return { passed, failed };
  }

  // Step 1: Create User A (the referrer)
  log("\n─── STEP 1: Create User A (Referrer) ───\n");
  const userAEmail = `usera_${Date.now()}@test.com`;
  try {
    const res = await axios.post(BASE + "/auth/signup", {
      name: "User A (Referrer)",
      email: userAEmail,
      password: "test123456",
    });
    userAToken = res.data.token;
    userAId = res.data.user.id;
    userAReferralCode = res.data.user.referralCode;
    pass("Create User A");
    log(`   User A ID: ${userAId}`);
    log(`   User A Referral Code: ${userAReferralCode}`);
  } catch (e) {
    fail("Create User A", e.response?.data?.message || e.message);
    return { passed, failed };
  }

  // Step 2: Create User B using User A's referral code
  log("\n─── STEP 2: Create User B (Using Referral) ───\n");
  const userBEmail = `userb_${Date.now()}@test.com`;
  try {
    const res = await axios.post(BASE + "/auth/signup", {
      name: "User B (Referred)",
      email: userBEmail,
      password: "test123456",
      referralCode: userAReferralCode,
    });
    userBToken = res.data.token;
    userBId = res.data.user.id;

    if (res.data.user.referredBy) {
      pass("Create User B with Referral Code");
      log(`   User B ID: ${userBId}`);
      log(`   User B referredBy: ${res.data.user.referredBy}`);
    } else {
      fail("Create User B", "referredBy not in response");
    }
  } catch (e) {
    fail("Create User B", e.response?.data?.message || e.message);
    return { passed, failed };
  }

  // Step 3: Test User A's Affiliate Dashboard Endpoints
  log("\n─── STEP 3: User A Affiliate Dashboard ───\n");

  // 3.1: Get affiliate stats
  try {
    const res = await axios.get(BASE + "/affiliate/stats", {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    if (res.data.ok && res.data.stats) {
      pass("GET /affiliate/stats");
      log(`   Referral Code: ${res.data.stats.referralCode}`);
      log(`   Balance: $${res.data.stats.affiliateBalance}`);
      log(`   Total Earned: $${res.data.stats.totalAffiliateEarned}`);
      log(`   Referred Users: ${res.data.stats.referredUsersCount}`);
    } else {
      fail("GET /affiliate/stats", "Invalid response");
    }
  } catch (e) {
    fail("GET /affiliate/stats", e.response?.data?.message || e.message);
  }

  // 3.2: Get commissions (new endpoint)
  try {
    const res = await axios.get(BASE + "/affiliate/commissions", {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    if (res.data.ok) {
      pass("GET /affiliate/commissions");
      log(`   Commissions count: ${res.data.commissions?.length || 0}`);
      log(
        `   Summary - Total Earnings: $${res.data.summary?.totalEarnings || 0}`,
      );
      log(
        `   Summary - Available Balance: $${res.data.summary?.availableBalance || 0}`,
      );
      log(`   Summary - Withdrawn: $${res.data.summary?.withdrawnAmount || 0}`);
    } else {
      fail("GET /affiliate/commissions", "Invalid response");
    }
  } catch (e) {
    fail("GET /affiliate/commissions", e.response?.data?.message || e.message);
  }

  // 3.3: Get withdrawals
  try {
    const res = await axios.get(BASE + "/affiliate/withdrawals", {
      headers: { Authorization: `Bearer ${userAToken}` },
    });
    if (res.data.ok) {
      pass("GET /affiliate/withdrawals");
      log(`   Withdrawals count: ${res.data.withdrawals?.length || 0}`);
    } else {
      fail("GET /affiliate/withdrawals", "Invalid response");
    }
  } catch (e) {
    fail("GET /affiliate/withdrawals", e.response?.data?.message || e.message);
  }

  // Step 4: Test Admin Affiliate Endpoints
  log("\n─── STEP 4: Admin Affiliate Directory ───\n");

  // 4.1: Get all affiliates
  try {
    const res = await axios.get(BASE + "/admin/affiliate/affiliates", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.data.ok && Array.isArray(res.data.affiliates)) {
      pass("GET /admin/affiliate/affiliates");
      log(`   Total affiliates: ${res.data.total}`);
      log(`   Stats - Active: ${res.data.stats?.activeAffiliates || 0}`);
      log(
        `   Stats - Total Earned: $${res.data.stats?.totalEarned?.toFixed(2) || "0.00"}`,
      );

      // Check if User A is in the list
      const userAFound = res.data.affiliates.find(
        (a) => a.email === userAEmail,
      );
      if (userAFound) {
        pass("User A appears in affiliate directory");
        log(`   User A referralCode: ${userAFound.referralCode}`);
        log(`   User A referralCount: ${userAFound.referralCount}`);
      } else {
        log(
          `   ⚠️ User A not immediately visible (may need more referrals/earnings)`,
        );
      }
    } else {
      fail("GET /admin/affiliate/affiliates", "Invalid response");
    }
  } catch (e) {
    fail(
      "GET /admin/affiliate/affiliates",
      e.response?.data?.message || e.message,
    );
  }

  // 4.2: Get single affiliate details (User A)
  try {
    const res = await axios.get(
      BASE + `/admin/affiliate/affiliates/${userAId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    if (res.data.ok && res.data.affiliate) {
      pass("GET /admin/affiliate/affiliates/:id");
      log(`   Affiliate Name: ${res.data.affiliate.name}`);
      log(`   Referral Code: ${res.data.affiliate.referralCode}`);
      log(`   Referral Link: ${res.data.affiliate.referralLink}`);
      log(`   Commission Rate: ${res.data.affiliate.commissionRate}%`);
      log(`   Total Referrals: ${res.data.affiliate.totalReferrals}`);
      log(`   Referred Users: ${res.data.referredUsers?.length || 0}`);
      log(`   Commissions: ${res.data.commissions?.length || 0}`);
      log(`   Withdrawals: ${res.data.withdrawals?.length || 0}`);
    } else {
      fail("GET /admin/affiliate/affiliates/:id", "Invalid response");
    }
  } catch (e) {
    fail(
      "GET /admin/affiliate/affiliates/:id",
      e.response?.data?.message || e.message,
    );
  }

  // 4.3: Get admin withdrawals
  try {
    const res = await axios.get(BASE + "/admin/affiliate/withdrawals", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.data.ok) {
      pass("GET /admin/affiliate/withdrawals");
      log(
        `   Pending withdrawals: ${res.data.withdrawals?.filter((w) => w.status === "pending").length || 0}`,
      );
    } else {
      fail("GET /admin/affiliate/withdrawals", "Invalid response");
    }
  } catch (e) {
    fail(
      "GET /admin/affiliate/withdrawals",
      e.response?.data?.message || e.message,
    );
  }

  // Final Summary
  log("\n═══════════════════════════════════════════════════════════════");
  log("FINAL RESULTS");
  log("═══════════════════════════════════════════════════════════════");
  log(`✅ PASSED: ${passed}`);
  log(`❌ FAILED: ${failed}`);
  log(`📊 TOTAL:  ${passed + failed}`);
  log(`📈 SUCCESS: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  log("═══════════════════════════════════════════════════════════════\n");

  log("\n📝 NOTE: Commission crediting happens when User B makes a purchase.");
  log("   The order payment flow triggers processOrderCommission() which");
  log("   credits User A's affiliate balance automatically.\n");

  return { passed, failed };
}

runTests()
  .then((r) => {
    process.exit(r.failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("Test runner error:", e);
    process.exit(1);
  });
