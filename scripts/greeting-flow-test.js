const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("TEST");
// Test that greeting mid-flow resets the flow
const BASE_URL = baseUrl;

async function t() {
  const l = await testFetch(BASE_URL + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  const d = await l.json();
  if (!d.token) return console.log("login failed");
  const tk = d.token;

  console.log("=== Test: Greeting mid-flow resets flow ===\n");

  // Step 1: Start a flow (e.g., "buy service")
  console.log("Step 1: Start 'buy service' flow...");
  const r1 = await testFetch(BASE_URL + "/api/jarvisx/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tk,
    },
    body: JSON.stringify({ message: "buy service" }),
  });
  const j1 = await r1.json();
  console.log("  Intent:", j1.intent);
  console.log("  Reply:", j1.reply?.substring(0, 100) + "...\n");

  // Step 2: Now send "hello" while mid-flow
  console.log("Step 2: Send 'hello' mid-flow...");
  const r2 = await testFetch(BASE_URL + "/api/jarvisx/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tk,
    },
    body: JSON.stringify({ message: "hello" }),
  });
  const j2 = await r2.json();
  console.log("  Intent:", j2.intent);
  console.log("  Expected: GREETING_RESET");
  console.log(
    "  Result:",
    j2.intent === "GREETING_RESET" ? "✅ PASS" : "❌ FAIL",
  );
  console.log("  Reply:", j2.reply?.substring(0, 100) + "...\n");
}

t();
