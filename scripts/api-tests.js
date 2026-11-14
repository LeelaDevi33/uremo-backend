const { baseUrl, testFetch } = require("./test-target");
(async () => {
  const base = baseUrl;
  const email = `test+dev1+${Date.now()}@example.com`;
  const password = require("node:crypto").randomUUID();
  let token = null;

  async function post(path, body, tkn) {
    const headers = { "Content-Type": "application/json" };
    if (tkn) headers.Authorization = `Bearer ${tkn}`;
    const res = await testFetch(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }

  async function get(path, tkn) {
    const headers = {};
    if (tkn) headers.Authorization = `Bearer ${tkn}`;
    const res = await testFetch(base + path, { headers });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }

  try {
    const signup = await post("/api/auth/signup", {
      name: "Dev Test",
      email,
      password,
    });
    console.log("--- SIGNUP ---");
    console.log("status:", signup.status);
    console.log("body:", JSON.stringify({ hasSession: Boolean(signup.body?.token), message: signup.body?.message }));
    if (signup.status === 200 || signup.status === 201)
      token = signup.body.token;
  } catch (e) {
    console.error("Signup request failed", e);
  }

  if (!token) {
    try {
      const login = await post("/api/auth/login", { email, password });
      console.log("--- LOGIN ---");
      console.log("status:", login.status);
      console.log("body:", JSON.stringify({ hasSession: Boolean(login.body?.token), message: login.body?.message }));
      if (login.status === 200) token = login.body.token;
    } catch (e) {
      console.error("Login request failed", e);
    }
  }

  if (!token) {
    console.log("No token obtained, aborting further tests.");
    process.exit(0);
  }

  try {
    const services = await get("/api/services", token);
    console.log("--- SERVICES ---");
    console.log("status:", services.status);
    console.log("body:", JSON.stringify(services.body, null, 2));
    if (Array.isArray(services.body) && services.body.length > 0) {
      const sid =
        services.body[0]._id || services.body[0].id || services.body[0].ID;
      if (sid) {
        const order = await post("/api/orders", { serviceId: sid }, token);
        console.log("--- CREATE ORDER ---");
        console.log("status:", order.status);
        console.log("body:", JSON.stringify(order.body, null, 2));

        const methods = await get("/api/payments", token);
        console.log("--- PAYMENT METHODS ---");
        console.log("status:", methods.status);
        console.log("body:", JSON.stringify(methods.body, null, 2));

        const orderId = order.body?._id;
        const methodId = Array.isArray(methods.body)
          ? methods.body[0]?._id
          : null;
        if (orderId && methodId) {
          const submit = await testFetch(`${base}/api/orders/${orderId}/payment`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              methodId,
              reference: "DEV-TEST",
              proofUrl: "https://example.com/proof.png",
            }),
          });
          const submitText = await submit.text();
          let submitBody;
          try {
            submitBody = JSON.parse(submitText);
          } catch {
            submitBody = submitText;
          }
          console.log("--- SUBMIT PAYMENT ---");
          console.log("status:", submit.status);
          console.log("body:", JSON.stringify(submitBody, null, 2));
        } else {
          console.log(
            "Skipping payment submission (missing orderId or payment methods)."
          );
        }
      } else {
        console.log("No service id found in first service.");
      }
    } else {
      console.log("No services available to create order.");
    }
  } catch (e) {
    console.error("Services/order test failed", e);
  }
})();
