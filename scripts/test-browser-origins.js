const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

test("HTTP and Socket.IO use the same browser origins", async (t) => {
  process.env.FRONTEND_URL = "https://frontend.qa.example/";
  process.env.CORS_ALLOWED_ORIGINS = "https://staging.qa.example, https://preview.qa.example:8443";
  const app = require("../src/app");
  const { initSocket } = require("../src/socket");
  const server = http.createServer(app);
  const io = initSocket(server);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => io.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = base + "/socket.io/?EIO=4&transport=";
  function upgrade(origin) {
    return new Promise((resolve, reject) => {
      const headers = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
        "sec-websocket-version": 13,
      };
      if (origin !== undefined) headers.origin = origin;
      const req = http.get(engine + "websocket", { headers });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
    });
  }

  const allowed = [
    undefined,
    "https://uremo-frontend.vercel.app",
    "https://uremo-frontend-git-main-uremos-projects.vercel.app",
    "http://localhost:3000",
    "https://frontend.qa.example",
    "https://staging.qa.example",
    "https://preview.qa.example:8443",
  ];
  for (const origin of allowed) {
    await t.test(origin || "server request without Origin", async () => {
      const headers = origin ? { origin, "access-control-request-method": "GET" } : {};
      const res = await fetch(base + "/api/health", { headers, method: origin ? "OPTIONS" : "GET" });
      assert.equal(res.status, origin ? 204 : 200);
      assert.equal(res.headers.get("access-control-allow-origin"), origin || null);
      const socket = await fetch(engine + "polling", { headers });
      assert.equal(socket.status, 200);
      assert.equal(socket.headers.get("access-control-allow-origin"), origin || null);
      assert.match(await socket.text(), /^0\{/);
      if (origin) assert.equal(res.headers.get("access-control-allow-credentials"), "true");
      assert.equal(await upgrade(origin), 101);
    });
  }

  for (const origin of [
    "https://qa-unrelated-origin.vercel.app",
    "https://uremo-frontend.vercel.app.attacker.test",
    "https://uremo-frontend-git-other-uremos-projects.vercel.app",
    "https://preview.qa.example",
    "null",
  ]) {
    await t.test("deny " + origin, async () => {
      const headers = { origin, "access-control-request-method": "GET" };
      const httpResult = await fetch(base + "/api/health", { headers, method: "OPTIONS" });
      assert.equal(httpResult.status, 403);
      assert.equal(httpResult.headers.has("access-control-allow-origin"), false);
      const socketResult = await fetch(engine + "polling", { headers });
      assert.ok(socketResult.status >= 400);
      assert.equal(socketResult.headers.has("access-control-allow-origin"), false);
      assert.notEqual(await upgrade(origin), 101);
    });
  }
});
