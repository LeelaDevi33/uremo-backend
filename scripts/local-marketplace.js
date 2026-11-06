// Run the two sibling checkouts against an isolated, loopback-only replica set.
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mongoose = require("mongoose");

const site = "http://localhost:3137";
const api = "http://localhost:5137";
const database = "mongodb://127.0.0.1:27347/uremo_market_preview?replicaSet=uremoLocal";
const frontend = path.resolve(__dirname, "../../frontend");

async function run() {
  const next = require.resolve("next/dist/bin/next", { paths: [frontend] });
  // The preview is deliberately isolated from provider keys, hosted databases and .env files.
  for (const key of ["GROQ_API_KEY", "RESEND_API_KEY", "CLOUDINARY_NAME", "CLOUDINARY_KEY",
    "CLOUDINARY_SECRET", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_URL",
    "STRIPE_SECRET_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
    delete process.env[key];
  }
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.MONGO_URI = database;
  process.env.FRONTEND_URL = site;
  process.env.CORS_ALLOWED_ORIGINS = "http://127.0.0.1:3137";
  await mongoose.connect(database, { serverSelectionTimeoutMS: 4000 });

  const server = http.createServer(require("../src/app"));
  require("../src/socket").initSocket(server);
  await new Promise((resolve, reject) => server.once("error", reject).listen(5137, "127.0.0.1", resolve));
  try {
    if (process.argv.includes("--demo")) await prepareDemo();
  } catch (err) {
    server.close();
    throw err;
  }
  const mode = process.argv.includes("--production") ? ["start"] : ["dev", "--webpack"];
  const client = spawn(process.execPath, [next, ...mode, "--hostname", "127.0.0.1", "--port", "3137"], {
    cwd: frontend, stdio: "inherit", windowsHide: true,
    env: { ...process.env, NEXT_PUBLIC_API_URL: api, JARVISX_BACKEND_URL: api, NEXT_TELEMETRY_DISABLED: "1" },
  });
  console.log("UREMO local preview:", site + "/explore-services");
  let stopping = false;
  async function stop(code) {
    if (stopping) return;
    stopping = true;
    if (client.exitCode === null) client.kill();
    server.close();
    await mongoose.disconnect();
    process.exit(code);
  }
  client.once("error", err => { console.error(err.message); stop(1); });
  client.once("exit", code => stop(code ?? 0));
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
}

async function prepareDemo() {
  const User = require("../src/models/User");
  const WorkPosition = require("../src/models/WorkPosition");
  const Opportunity = require("../src/models/Opportunity");
  for (const [name, email, role, walletBalance] of [
    ["Preview Editor", "studio@uremo.example", "admin", 0],
    ["Preview Worker", "worker@uremo.example", "user", 240],
  ]) {
    if (await User.exists({ email })) continue;
    const password = randomBytes(18).toString("base64url");
    await User.create({ name, email, password, role, walletBalance });
    console.log("New disposable localhost login (shown once):", email, password);
  }
  if (await Opportunity.exists({})) return;
  const title = "Accessibility review for a booking app";
  const description = "Review the booking flow with a keyboard and screen reader. Deliver an issue list with steps to reproduce and suggested fixes.";
  await mongoose.connection.transaction(async session => {
    const [role] = await WorkPosition.create([{ title, category: "development", description, active: true }], { session, ordered: true });
    await Opportunity.create([{
      title, description, category: "development", workPositionId: role._id, status: "published",
      rightsConfirmed: true, firstPublishedAt: new Date(), applyEnabled: true, rentEnabled: true,
      rentPrice: 18, rentalDays: 7, buyEnabled: true, buyPrice: 95,
      deliverable: "Local sample project brief. This fixture contains no client assets.",
    }], { session, ordered: true });
  });
}

run().catch(async err => {
  console.error("Preview could not start:", err.message);
  console.error("See LOCAL_DEVELOPMENT.md for the local replica and port requirements.");
  await mongoose.disconnect();
  process.exitCode = 1;
});
