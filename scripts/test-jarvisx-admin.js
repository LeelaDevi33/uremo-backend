/**
 * JarvisX Admin Chat Mode Tests
 */
const { baseUrl: BASE_URL, email, password, testFetch } = require("./admin-test-config");

async function test() {
  console.log("=".repeat(60));
  console.log("JARVISX ADMIN CHAT MODE TEST");
  console.log("=".repeat(60));

  // Login first
  const loginRes = await testFetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
    }),
  });
  const loginData = await loginRes.json();

  if (!loginData.token) {
    console.log("❌ Login failed");
    return;
  }
  console.log("✅ Login OK (role:", loginData.user?.role + ")");
  const token = loginData.token;

  // Test various admin chat commands
  const tests = [
    { msg: "show me available services", expected: "LIST_SERVICES" },
    { msg: "I want to create a new service", expected: "ADMIN_CREATE_SERVICE" },
    { msg: "add new service", expected: "ADMIN_CREATE_SERVICE" },
    { msg: "help me create a service", expected: "ADMIN_CREATE_SERVICE" },
    { msg: "what's my name?", expected: "USER_IDENTITY_QUERY" },
    { msg: "who are you?", expected: "ASSISTANT_IDENTITY" },
    { msg: "1", expected: "ORDINAL_SELECTION" },
    { msg: "hello", expected: "GENERAL_CHAT" },
    { msg: "what services are available", expected: "LIST_SERVICES" },
  ];

  console.log("\n--- Testing Intents ---\n");

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const res = await testFetch(`${BASE_URL}/api/jarvisx/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message: t.msg }),
    });
    const data = await res.json();

    const match = data.intent === t.expected;
    if (match) passed++;
    else failed++;

    console.log(`${match ? "✅" : "❌"} "${t.msg}"`);
    console.log(`   Expected: ${t.expected}`);
    console.log(`   Got:      ${data.intent}`);
    if (!match) {
      console.log(`   Reply: ${(data.reply || "").substring(0, 80)}...`);
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
}

test();
