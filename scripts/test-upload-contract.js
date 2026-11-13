const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");

async function listen(server, t) {
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

test("multipart proof and image uploads pass through the Cloudinary SDK", async t => {
  const received = [];
  const provider = await listen(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, payload: Buffer.concat(chunks).toString() });
    const type = req.url.includes("/raw/") ? "raw" : "image";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      secure_url: "https://media.example.invalid/uploaded", public_id: "fixture-id",
      resource_type: type, format: type === "raw" ? "pdf" : "png",
    }));
  }), t);
  // Set the upload origin before importing the SDK so even its transport is loopback-only.
  delete process.env.CLOUDINARY_API_PROXY;
  process.env.CLOUDINARY_NAME = "fixture";
  process.env.CLOUDINARY_API_KEY = "fixture-key";
  process.env.CLOUDINARY_API_SECRET = randomBytes(20).toString("hex");
  process.env.CLOUDINARY_URL = "cloudinary://fixture-key:fixture-secret@fixture?upload_prefix=" + encodeURIComponent(provider);
  process.env.JWT_SECRET = randomBytes(24).toString("hex");
  const app = require("express")();
  app.use("/api/upload", require("../src/routes/upload.routes"));
  const base = await listen(createServer(app), t);
  const token = jwt.sign({ id: randomBytes(12).toString("hex") }, process.env.JWT_SECRET);
  const headers = { Authorization: "Bearer " + token };

  for (const [route, field, mime, expected, contents] of [
    ["payment-proof", "file", "application/pdf", "raw", "%PDF-1.4 fixture"],
    ["image", "image", "image/png", "image", "image fixture bytes"],
  ]) {
    const form = new FormData();
    form.append(field, new Blob([contents], { type: mime }), expected === "raw" ? "proof.pdf" : "image.png");
    const response = await fetch(base + "/api/upload/" + route, { method: "POST", headers, body: form });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.publicId, "fixture-id");
    assert.equal(data.url, "https://media.example.invalid/uploaded");
    if (expected === "raw") assert.equal(data.resourceType, expected);
    else assert.equal(data.ok, true);
    assert.equal(received.at(-1).path, "/v1_1/fixture/" + expected + "/upload");
    assert.ok(received.at(-1).payload.includes(contents));
    assert.ok(received.at(-1).payload.includes('name="signature"'));
  }
  const retired = await fetch(base + "/api/upload", { method: "POST", headers });
  assert.equal(retired.status, 410);
  assert.match((await retired.json()).message, /payment-proof/);
  const guest = await fetch(base + "/api/upload/payment-proof", { method: "POST" });
  assert.equal(guest.status, 401);
  assert.equal(received.length, 2);
});
