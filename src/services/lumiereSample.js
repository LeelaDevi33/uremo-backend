const Opportunity = require("../models/Opportunity");
const Project = require("../models/Project");
const WorkPosition = require("../models/WorkPosition");

// Stable IDs let an admin reopen the same draft and preserve all later edits.
const roleId = "6af72a52dc662aac800b4e28";
const projectId = "6af72a53dc662aac800b4e29";
const offerId = "6af72a53dc662aac800b4e2d";
const title = "Lumiere Life Science";
const description = "Compare two light schedules in a fictional seed-germination experiment. Calculate the germination rate for each tray, explain the limits of the comparison and write a one-page evidence brief.";

async function createLumiereSample(session, { activeRole = false, createdBy } = {}) {
  const existing = await Opportunity.findById(offerId).session(session).select("projectId projectRoleId").lean();
  if (existing) return { id: offerId, created: false };
  const now = new Date();
  const insert = { session, upsert: true, timestamps: false, runValidators: true };
  await WorkPosition.updateOne({ _id: roleId }, { $setOnInsert: {
    title: "Life science research review", category: "research", active: activeRole,
    description: "Review a life science research brief, check which claims the evidence supports and explain the results in plain English.",
    skills: ["Scientific literature review", "Source verification", "Research writing"],
    responsibilities: ["Check each claim against the available evidence.", "Document study design and limitations.", "Write a plain-language summary."],
    requirements: "Read a scientific abstract and distinguish observation from inference.",
    experienceLevel: "intermediate", workMode: "remote", locationEligibility: "Any time zone",
    timeCommitment: "Approximately 3–5 hours per sample brief.", createdAt: now, updatedAt: now,
  } }, insert);
  await Project.updateOne({ _id: projectId }, { $setOnInsert: {
    title, description, workPositionId: roleId, category: "research", status: "draft",
    instructions: "Compare the groups in the handoff. Record the fractions and percentages, then summarize the result and propose a control.",
    deliverables: [
      { title: "Evidence table", description: "Include both groups, germination fractions and one study limitation.", required: true },
      { title: "Plain-language brief", description: "Summarize the results in one page and suggest a follow-up control.", required: true },
    ], payType: "fixed", payRate: 0, priority: "medium", createdBy, createdAt: now, updatedAt: now,
  } }, insert);
  await Opportunity.updateOne({ _id: offerId }, { $setOnInsert: {
    title, description, category: "research", projectId, projectRoleId: roleId, workPositionId: null, status: "draft",
    rentEnabled: true, rentPrice: 15, rentalDays: 7, buyEnabled: true, buyPrice: 60,
    rightsConfirmed: false, applyEnabled: false, createdAt: now, updatedAt: now,
    deliverable: [
      "Sample project handoff. In this fictional seven-day trial, group A received 12 hours of light a day and 18 of 24 seeds germinated. Group B received four hours of light a day and 12 of 24 seeds germinated.",
      "Each group used one tray and one seed batch. Prepare a table with group size, germinated count and percentage. Write a short conclusion explaining the limits of the comparison, and propose a controlled follow-up.",
    ].join("\n\n"),
  } }, insert);
  return { id: offerId, created: true };
}

module.exports = { createLumiereSample };
