// Run the two sibling checkouts against an isolated, loopback-only replica set.
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mongoose = require("mongoose");

function previewPort(name, fallback) {
  const value = process.env[name] || String(fallback);
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Invalid local preview port for ${name}`);
  }
  return Number(value);
}
const sitePort = previewPort("UREMO_PREVIEW_SITE_PORT", 3137);
const apiPort = previewPort("UREMO_PREVIEW_API_PORT", 5137);
if (sitePort === apiPort) throw new Error("The local site and API require separate ports.");
const site = `http://localhost:${sitePort}`;
const api = `http://localhost:${apiPort}`;
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
  process.env.CORS_ALLOWED_ORIGINS = `http://127.0.0.1:${sitePort}`;
  await mongoose.connect(database, { serverSelectionTimeoutMS: 4000 });

  const server = http.createServer(require("../src/app"));
  require("../src/socket").initSocket(server);
  await new Promise((resolve, reject) => server.once("error", reject).listen(apiPort, "127.0.0.1", resolve));
  try {
    if (process.argv.includes("--demo")) await prepareDemo();
  } catch (err) {
    server.close();
    throw err;
  }
  const mode = process.argv.includes("--production") ? ["start"] : ["dev", "--webpack"];
  const client = spawn(process.execPath, [next, ...mode, "--hostname", "127.0.0.1", "--port", String(sitePort)], {
    cwd: frontend, stdio: "inherit", windowsHide: true,
    env: { ...process.env, NEXT_PUBLIC_API_URL: api, JARVISX_BACKEND_URL: api, NEXT_TELEMETRY_DISABLED: "1" },
  });
  console.log("UREMO local preview:", site + "/open-roles", site + "/projects/rent", site + "/projects/full-access");
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
  if (mongoose.connection.name !== "uremo_market_preview" || mongoose.connection.host !== "127.0.0.1") {
    throw new Error("Demo fixtures require the local marketplace preview database");
  }
  const User = require("../src/models/User");
  const WorkPosition = require("../src/models/WorkPosition");
  const Opportunity = require("../src/models/Opportunity");
  const Project = require("../src/models/Project");
  const Application = require("../src/models/ApplyWork");
  for (const [name, email, role, walletBalance] of [
    ["Preview Editor", "studio@uremo.example", "admin", 0],
    ["Preview Worker", "worker@uremo.example", "user", 240],
  ]) {
    if (await User.exists({ email })) continue;
    const password = randomBytes(18).toString("base64url");
    await User.create({ name, email, password, role, walletBalance });
    console.log("New disposable localhost login (shown once):", email, password);
  }
  const samples = [
    ["000001", "Accessibility testing", "development", "Booking flow accessibility audit", "Review keyboard navigation, form labels and booking errors for a five-step appointment flow.", 18, 7, 95],
    ["000002", "Editorial quality assurance", "writing", "Editorial QA for a help centre", "Review six help articles against a style guide and document specific corrections.", 12, 4, 0],
    ["000003", "Product research", "research", "First-run interview analysis", "Take over the interview synthesis brief and produce a research readout from the example material.", 0, 0, 68],
  ];
  const id = (n, seq) => new mongoose.Types.ObjectId("5efe00000000000" + n + seq.padStart(8, "0"));
  const previousDescription = "Apply for this specialization to qualify for matching projects.";
  const briefs = {
    "000001": {
      description: "Test booking flows with a keyboard and screen reader. Help product teams find where a visitor loses focus, misses an error or cannot finish a task.",
      experienceLevel: "intermediate", workMode: "remote", locationEligibility: "Any time zone",
      timeCommitment: "2–4 hours per review",
      skills: ["Keyboard testing", "Screen readers", "Bug reporting"],
      responsibilities: ["Test the steps in a supplied flow using assistive technology.", "Write reproduction steps and explain the impact on the visitor."],
      requirements: "Experience testing at least one web flow using a keyboard and screen reader.\nAbility to write a clear, reproducible issue report.",
    },
    "000002": {
      description: "Review help articles for clarity, consistency and accuracy. Flag instructions that a reader cannot follow and recommend specific edits.",
      experienceLevel: "entry", workMode: "remote", locationEligibility: "Any time zone",
      timeCommitment: "1–3 hours per article batch",
      skills: ["Copyediting", "Style guides", "Written English"],
      responsibilities: ["Compare articles with the supplied source material and style guide.", "Record proposed edits and explain each substantive change."],
      requirements: "Ability to edit English prose for clarity.\nComfort checking claims against provided source material.",
    },
    "000003": {
      description: "Turn interview notes into findings a product team can act on. Distinguish recurring patterns from individual observations and show the evidence for each conclusion.",
      experienceLevel: "advanced", workMode: "remote", locationEligibility: "Any time zone",
      timeCommitment: "4–6 hours per research brief",
      skills: ["Interview synthesis", "Qualitative analysis", "Research writing"],
      responsibilities: ["Group interview observations into evidence-backed themes.", "Deliver a readout with supporting excerpts and open questions."],
      requirements: "Experience synthesizing qualitative research.\nAbility to distinguish what a participant said from an interpretation.",
    },
  };
  const worker = await User.findOne({ email: "worker@uremo.example" }).select("_id");
  await mongoose.connection.transaction(async session => {
    // Three project-shaped role fixtures from the original local walkthrough.
    // Match both known document IDs and their historical relationship.
    for (const [roleId, offerId, title] of [
      ["6aedaae827006857c0ba2a69", "6aedaae827006857c0ba2a6e", "Accessibility review for a booking app"],
      ["6aedaae827006857c0ba2a72", "6aedaae827006857c0ba2a77", "Label a small product image dataset"],
      ["6aedaae827006857c0ba2a7b", "6aedaae827006857c0ba2a80", "Design a project onboarding checklist"],
    ]) {
      const historicalOffer = await Opportunity.exists({ _id: offerId, title, workPositionId: roleId,
        projectId: null, projectRoleId: null, applyEnabled: true }).session(session);
      if (historicalOffer) await WorkPosition.updateOne({ _id: roleId, title, active: true },
        { $set: { active: false } }, { session });
    }
    for (const [seq, specialty, category, title, description, rentPrice, rentalDays, buyPrice] of samples) {
      const roleId = id(1, seq), projectId = id(2, seq), offerId = id(3, seq);
      const brief = briefs[seq];
      const createdAt = new Date();
      await WorkPosition.updateOne({ _id: roleId }, { $setOnInsert: {
        title: specialty, category, active: true, ...brief, createdAt, updatedAt: createdAt,
      } }, { session, upsert: true, timestamps: false });
      // Claim only the untouched previous demo brief. A cleared or customized
      // field must remain as the admin saved it on every subsequent restart.
      await WorkPosition.updateOne({
        _id: roleId, title: specialty, category, description: previousDescription,
        requirements: { $in: ["", null] }, experienceLevel: { $exists: false }, workMode: { $exists: false },
        locationEligibility: { $exists: false }, timeCommitment: { $exists: false },
        skills: { $exists: false }, responsibilities: { $exists: false },
      }, { $set: brief }, { session });
      await Project.updateOne({ _id: projectId }, { $setOnInsert: { title, description, workPositionId: roleId, category, status: "open", payRate: 0 } }, { session, upsert: true });
      await Opportunity.updateOne({ _id: offerId }, { $setOnInsert: {
        projectId, projectRoleId: roleId, workPositionId: null, title, description, category, status: "published",
        rightsConfirmed: true, firstPublishedAt: new Date(), projectPublishedAt: new Date(), applyEnabled: false,
        rentEnabled: rentPrice > 0, rentPrice, rentalDays, buyEnabled: buyPrice > 0, buyPrice,
        deliverable: "Sample project handoff: " + description + " Submit a concise findings report and an actionable checklist.",
      } }, { session, upsert: true });
      if (seq === "000001") await Application.updateOne({ user: worker._id, position: roleId },
        { $setOnInsert: { positionTitle: specialty, status: "approved", workerStatus: "ready_to_work" } }, { upsert: true, session });
    }
    // Keep the original preview IDs so saved admin links and later manual edits survive reseeding.
    const roleId = "6af72a52dc662aac800b4e28";
    const projectId = "6af72a53dc662aac800b4e29";
    const offerId = "6af72a53dc662aac800b4e2d";
    const title = "Lumiere Life Science";
    const description = "Compare two light schedules in a fictional seed-germination experiment. Calculate the germination rate for each tray, explain the limits of the comparison and write a one-page evidence brief.";
    const seedOptions = { session, upsert: true, timestamps: false };
    const createdAt = new Date();
    await WorkPosition.updateOne({ _id: roleId }, { $setOnInsert: {
      title: "Life science research review", category: "research", active: true,
      description: "Review a life science research brief, check which claims the evidence supports and explain the results in plain English.",
      skills: ["Scientific literature review", "Source verification", "Research writing"],
      responsibilities: ["Check each claim against the available evidence.", "Document study design and limitations.", "Write a plain-language summary."],
      requirements: "Read a scientific abstract and distinguish observation from inference.",
      experienceLevel: "intermediate", workMode: "remote", locationEligibility: "Any time zone",
      timeCommitment: "Approximately 3–5 hours per sample brief.", createdAt, updatedAt: createdAt,
    } }, seedOptions);
    await Project.updateOne({ _id: projectId }, { $setOnInsert: {
      title, description, workPositionId: roleId, category: "research", status: "draft",
      instructions: "Compare the groups in the handoff. Record the fractions and percentages, then summarize the result and propose a control.",
      deliverables: [
        { title: "Evidence table", description: "Include both groups, germination fractions and one study limitation.", required: true },
        { title: "Plain-language brief", description: "Summarize the results in one page and suggest a follow-up control.", required: true },
      ], payType: "fixed", payRate: 0, priority: "medium", createdAt, updatedAt: createdAt,
    } }, seedOptions);
    await Opportunity.updateOne({ _id: offerId }, { $setOnInsert: {
      title, description, category: "research", projectId, projectRoleId: roleId, workPositionId: null, status: "draft",
      rentEnabled: true, rentPrice: 15, rentalDays: 7, buyEnabled: true, buyPrice: 60,
      rightsConfirmed: false, applyEnabled: false, createdAt, updatedAt: createdAt,
      deliverable: [
        "Sample project handoff. In this fictional seven-day trial, group A received 12 hours of light a day and 18 of 24 seeds germinated. Group B received four hours of light a day and 12 of 24 seeds germinated.",
        "Each group used one tray and one seed batch. Prepare a table with group size, germinated count and percentage. Write a short conclusion explaining the limits of the comparison, and propose a controlled follow-up.",
      ].join("\n\n"),
    } }, seedOptions);
  });
}

if (require.main === module) run().catch(async err => {
  console.error("Preview could not start:", err.message);
  console.error("See LOCAL_DEVELOPMENT.md for the local replica and port requirements.");
  await mongoose.disconnect();
  process.exitCode = 1;
});
module.exports = { prepareDemo };
