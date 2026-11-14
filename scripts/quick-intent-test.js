const { baseUrl, testFetch, testCredentials } = require("./test-target");
const credentials = testCredentials("TEST");
const BASE_URL = baseUrl;
(async () => {
  const l = await testFetch(BASE_URL + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  const { token } = await l.json();

  const tests = [
    "can i trust you",
    "is this legit",
    "can i get a refund",
    "what if service not delivered",
  ];

  for (const msg of tests) {
    const r = await testFetch(BASE_URL + "/api/jarvisx/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ message: msg }),
    });
    const j = await r.json();
    console.log(msg + " => " + j.intent);
  }
})();
