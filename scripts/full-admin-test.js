const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("ADMIN");
/**
 * Full Admin Flow Test for PATCH_21
 */
const BASE_URL = baseUrl;

async function test() {
  console.log("=".repeat(60));
  console.log("PATCH_21 ADMIN FLOW TEST");
  console.log("Time:", new Date().toISOString());
  console.log("=".repeat(60));

  try {
    // 1. LOGIN
    console.log("\n[1] LOGIN...");
    const loginRes = await testFetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });
    const loginData = await loginRes.json();
    console.log("Status:", loginRes.status);
    console.log("Token:", loginData.token ? "YES" : "NO");
    console.log("Role:", loginData.user?.role);

    if (!loginData.token) {
      console.log("ERROR:", JSON.stringify({ hasSession: Boolean(loginData?.token), message: loginData?.message }));
      return;
    }
    console.log("✅ Login OK");
    const token = loginData.token;

    // 2. CREATE MICROJOBS SERVICE
    console.log("\n[2] CREATE MICROJOBS/FRESH SERVICE...");
    const svc1 = await testFetch(`${BASE_URL}/api/admin/services`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Outlier Math Expert (P21)",
        category: "microjobs",
        subcategory: "fresh_account",
        description: "Outlier AI Math expert application help",
        price: 35,
        platform: "Outlier",
        subject: "Math",
        countries: ["India", "USA"],
        status: "active",
      }),
    });
    const svc1Data = await svc1.json();
    console.log("Status:", svc1.status);
    console.log("OK:", svc1Data.ok);
    if (svc1Data.service) {
      console.log("✅ Created:", svc1Data.service._id);
    } else {
      console.log("❌ Error:", svc1Data.message, svc1Data.error);
    }

    // 3. CREATE FOREX SERVICE
    console.log("\n[3] CREATE FOREX/CRYPTO SERVICE...");
    const svc2 = await testFetch(`${BASE_URL}/api/admin/services`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "Bybit KYC Account (P21)",
        category: "forex_crypto",
        subcategory: "crypto_platform_creation",
        description: "Bybit verified crypto trading account",
        price: 45,
        platform: "Bybit",
        countries: ["India", "UAE"],
        status: "active",
      }),
    });
    const svc2Data = await svc2.json();
    console.log("Status:", svc2.status);
    console.log("OK:", svc2Data.ok);
    if (svc2Data.service) {
      console.log("✅ Created:", svc2Data.service._id);
    } else {
      console.log("❌ Error:", svc2Data.message, svc2Data.error);
    }

    // 4. CREATE BANKS SERVICE
    console.log("\n[4] CREATE BANKS/WALLETS SERVICE...");
    const svc3 = await testFetch(`${BASE_URL}/api/admin/services`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: "PayPal Business (P21)",
        category: "banks_gateways_wallets",
        subcategory: "payment_gateways",
        description: "PayPal Business verified account",
        price: 75,
        platform: "PayPal",
        countries: ["USA", "UK"],
        status: "active",
      }),
    });
    const svc3Data = await svc3.json();
    console.log("Status:", svc3.status);
    console.log("OK:", svc3Data.ok);
    if (svc3Data.service) {
      console.log("✅ Created:", svc3Data.service._id);
    } else {
      console.log("❌ Error:", svc3Data.message, svc3Data.error);
    }

    // 5. LIST SERVICES
    console.log("\n[5] LIST ADMIN SERVICES...");
    const listRes = await testFetch(`${BASE_URL}/api/admin/services`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = await listRes.json();
    const services = Array.isArray(listData)
      ? listData
      : listData.services || [];
    console.log("Total Services:", services.length);

    // 6. EDIT FIRST SERVICE
    if (services.length > 0) {
      console.log("\n[6] EDIT SERVICE:", services[0].title);
      const editRes = await testFetch(
        `${BASE_URL}/api/admin/services/${services[0]._id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            price: services[0].price + 1,
            shortDescription: "Updated by P21 test",
          }),
        },
      );
      const editData = await editRes.json();
      console.log("Edit Status:", editRes.status);
      console.log("Edit OK:", editData.ok);
      if (editData.ok) {
        console.log("✅ Updated price to:", editData.service?.price);
      } else {
        console.log("❌ Edit Error:", editData.message, editData.error);
      }
    }

    // 7. JARVISX ADMIN: LIST SERVICES
    console.log("\n[7] JARVISX: 'show services'...");
    const j1 = await testFetch(`${BASE_URL}/api/jarvisx/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message: "show me available services" }),
    });
    const j1Data = await j1.json();
    console.log("Intent:", j1Data.intent);
    console.log("Reply:", (j1Data.reply || "").substring(0, 100) + "...");

    // 8. JARVISX ADMIN: CREATE COMMAND
    console.log("\n[8] JARVISX: 'create a service'...");
    const j2 = await testFetch(`${BASE_URL}/api/jarvisx/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message: "I want to add a new service" }),
    });
    const j2Data = await j2.json();
    console.log("Intent:", j2Data.intent);
    console.log("Reply:", (j2Data.reply || "").substring(0, 100) + "...");

    // SUMMARY
    console.log("\n" + "=".repeat(60));
    console.log("DONE");
    console.log("=".repeat(60));
  } catch (err) {
    console.error("FATAL:", err.message);
  }
}

test();
