const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("TEST");
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

  // Note: "hello" without active flow returns GENERAL_CHAT (expected)
  // Use greeting-flow-test.js to test GREETING_RESET mid-flow behavior
  const tests = [
    ["show me available services", "LIST_SERVICES"],
    ["I want to create a new service", "ADMIN_CREATE_SERVICE"],
    ["add new service", "ADMIN_CREATE_SERVICE"],
    ["what is my name", "USER_IDENTITY_QUERY"],
    ["who are you", "ASSISTANT_IDENTITY"],
    ["1", "ORDINAL_NO_CONTEXT"],
    ["hello", "GENERAL_CHAT"], // Correct: no active flow = GENERAL_CHAT
  ];

  for (const [msg, exp] of tests) {
    const r = await testFetch(BASE_URL + "/api/jarvisx/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tk,
      },
      body: JSON.stringify({ message: msg }),
    });
    const j = await r.json();
    const ok = j.intent === exp;
    console.log(
      (ok ? "✅" : "❌") +
        " " +
        msg +
        " => " +
        j.intent +
        " (exp: " +
        exp +
        ")",
    );
  }
}

t();
