const { baseUrl, testFetch } = require("./scripts/test-target");
const { randomUUID } = require("node:crypto");
const credentials = { email: "auth-" + randomUUID() + "@example.test", password: randomUUID() };
(async () => {
  const base = baseUrl;

  console.log("📝 Testing SIGNUP API...\n");

  try {
    // Signup first
    const signupRes = await testFetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Final Test",
        email: credentials.email,
        password: credentials.password,
      }),
    });

    const signupData = await signupRes.json();
    console.log(`Signup Status: ${signupRes.status}`);
    console.log("Signup Response:", JSON.stringify({ hasSession: Boolean(signupData?.token), message: signupData?.message }));

    if (signupRes.status === 201 || signupRes.status === 400) {
      console.log("\n✅ User exists or was created\n");

      // Now try login
      console.log("🔐 Testing LOGIN API...\n");

      const loginRes = await testFetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });

      const loginData = await loginRes.json();
      console.log(`Login Status: ${loginRes.status}\n`);

      if (loginRes.status === 200 && loginData.token) {
        console.log("✅ LOGIN SUCCESSFUL!\n");
        console.log("Response:");
        console.log(JSON.stringify({ hasSession: Boolean(loginData?.token), message: loginData?.message }));

        // Test protected route
        console.log("\n\n🔒 Testing PROTECTED ROUTE...\n");

        const ordersRes = await testFetch(`${base}/api/orders/my`, {
          headers: {
            Authorization: `Bearer ${loginData.token}`,
          },
        });

        const ordersText = await ordersRes.text();
        console.log(`Status Code: ${ordersRes.status}`);
        console.log("Response:", ordersText);

        if (ordersRes.status === 200) {
          console.log("\n✅ PROTECTED ROUTE WORKS!");
        } else {
          console.log("\n⚠️ Protected route status:", ordersRes.status);
        }
      } else {
        console.log("❌ LOGIN FAILED\n");
        console.log("Response:");
        console.log(JSON.stringify({ hasSession: Boolean(loginData?.token), message: loginData?.message }));
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
})();
