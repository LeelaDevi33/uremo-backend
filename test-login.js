const { baseUrl, testFetch, testCredentials } = require("./scripts/test-target");
const credentials = testCredentials("TEST");
(async () => {
  const base = baseUrl;

  console.log("🔐 Testing LOGIN API...\n");

  try {
    const res = await testFetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });

    const data = await res.json();
    console.log(`Status Code: ${res.status}\n`);

    if (res.status === 200 && data.token) {
      console.log("✅ LOGIN SUCCESSFUL!\n");
      console.log("Response:");
      console.log(JSON.stringify({ hasSession: Boolean(data?.token), message: data?.message }));

      // Test protected route
      console.log("\n\n🔒 Testing PROTECTED ROUTE...\n");

      const ordersRes = await testFetch(`${base}/api/orders/my`, {
        headers: {
          Authorization: `Bearer ${data.token}`,
        },
      });

      const ordersData = await ordersRes.json();
      console.log(`Status Code: ${ordersRes.status}`);
      console.log("Response:");
      console.log(JSON.stringify(ordersData, null, 2));

      if (ordersRes.status === 200) {
        console.log("\n✅ PROTECTED ROUTE WORKS!");
      } else {
        console.log("\n⚠️ Protected route returned:", ordersRes.status);
      }
    } else {
      console.log("❌ LOGIN FAILED\n");
      console.log("Response:");
      console.log(JSON.stringify({ hasSession: Boolean(data?.token), message: data?.message }));
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
})();
