const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("TEST");
// JarvisX User Flow Test - Testing realistic user queries
const BASE_URL = baseUrl;

async function chat(token, message) {
  const r = await testFetch(BASE_URL + "/api/jarvisx/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ message }),
  });
  return r.json();
}

async function testUserFlow() {
  // Login as regular user (not admin)
  console.log("=== JarvisX User Flow Test (PATCH_22) ===\n");

  const l = await testFetch(BASE_URL + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  const d = await l.json();
  if (!d.token) return console.log("Login failed");
  const tk = d.token;
  console.log("✅ Logged in\n");

  // User queries to test
  const queries = [
    "hey",
    "which services can i avail from here",
    "can i really trust the platform",
    "what makes it trusted for its users",
    "how can i avail a service",
    "how should i get the service delivered",
    "how long it will take to get the service delivered for microjob fresh outlier account",
    "can i get an instant ready to task account",
    "which forex trading platforms are available",
    "can i get a hfm forex mexico country service/account",
    "can i get a refund if my service not get delivered",
    "or if i face any difficulties",
  ];

  const results = [];

  for (const q of queries) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`USER: "${q}"`);
    console.log("-".repeat(60));

    const res = await chat(tk, q);
    console.log(`INTENT: ${res.intent}`);
    console.log(`REPLY: ${res.reply}`);
    if (res.quickReplies?.length) {
      console.log(`QUICK REPLIES: ${res.quickReplies.join(" | ")}`);
    }

    results.push({
      query: q,
      intent: res.intent,
      reply: res.reply,
      quickReplies: res.quickReplies,
    });

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("=== SUMMARY ===");
  console.log("=".repeat(60));

  for (const r of results) {
    const status = r.reply && r.reply.length > 20 ? "✅" : "⚠️";
    console.log(`${status} "${r.query}" => ${r.intent}`);
  }
}

testUserFlow().catch(console.error);
