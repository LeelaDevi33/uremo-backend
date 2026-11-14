const { baseUrl, testCredentials } = require("./test-target");
const credentials = testCredentials("ADMIN");
/**
 * Test Referral Code Linking - Live Production Test
 */

const axios = require("axios").create({ maxRedirects: 0 });
const fs = require("fs");
const BASE = baseUrl + "/api";

const output = [];
function log(msg) {
  console.log(msg);
  output.push(msg);
}

async function testReferral() {
  try {
    // 1. Login as admin to get a valid referral code
    console.log("1. Getting admin referral code...");
    const login = await axios.post(BASE + "/auth/login", {
      email: credentials.email,
      password: credentials.password,
    });
    console.log("   Admin referralCode:", login.data.user.referralCode);
    console.log("   Admin userId:", login.data.user._id || login.data.user.id);

    // 2. Create a test user with the referral code
    const testEmail = "reftest" + Date.now() + "@test.com";
    console.log("\n2. Creating user with referral code...");
    console.log("   Email:", testEmail);
    console.log("   Using referralCode:", login.data.user.referralCode);

    const signup = await axios.post(BASE + "/auth/signup", {
      name: "Referral Tester",
      email: testEmail,
      password: "test123456",
      referralCode: login.data.user.referralCode,
    });

    console.log("\n3. New user created:");
    console.log("   User ID:", signup.data.user._id || signup.data.user.id);
    console.log("   referredBy:", signup.data.user.referredBy);
    console.log(
      "   Full user object:",
      JSON.stringify(signup.data.user, null, 2),
    );

    console.log("\n=== RESULT ===");
    if (signup.data.user.referredBy) {
      console.log("✅ SUCCESS: Referral linking works!");
    } else {
      console.log("❌ FAILED: referredBy is not set");
      console.log("   Need to investigate auth.controller.js signup function");
    }
  } catch (err) {
    log(
      "ERROR:" +
        (err.response
          ? JSON.stringify(err.response.data, null, 2)
          : err.message),
    );
  } finally {
    fs.writeFileSync("../tmp-referral-test.txt", output.join("\n"));
    log("Output written to ../tmp-referral-test.txt");
  }
}

testReferral();
