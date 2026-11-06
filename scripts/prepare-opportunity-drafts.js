const fs = require("node:fs/promises");
const { parseArgs } = require("node:util");
const mongoose = require("mongoose");
const Opportunity = require("../src/models/Opportunity");
const WorkPosition = require("../src/models/WorkPosition");
const Service = require("../src/models/Service");

const usage = `Prepare application-only drafts in a local MongoDB replica set.
  node scripts/prepare-opportunity-drafts.js --db NAME [--port 27017] --role ROLE_ID [--role ROLE_ID ...] [--write]
  node scripts/prepare-opportunity-drafts.js --db NAME [--port 27017] --map reviewed-roles.json [--write]
  Map format: {"24-hex-role-id": "design"}. Use --role for roles already in a supported project category.
  The default dry run only reads. --write copies the role title and leaves description, rights and pricing for admin review.
  The connection is loopback-only. Database credentials and environment connection strings are never loaded.`;

class InputError extends Error {}
const categories = Opportunity.schema.path("category").enumValues.filter(Boolean);
const legacyProjectCategories = new Set([...categories, "microjobs", "online_gigs"]);
const accountProduct = /\b(?:forex|crypto|cryptocurrency|bank|banks|banking|wallets?|gateways?|accounts?|trading|finance|financial|loans?|rentals?|onboarded|verified|whatsapp)\b/i;

async function readCommand(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      db: { type: "string" }, port: { type: "string", default: "27017" }, role: { type: "string", multiple: true },
      map: { type: "string" }, write: { type: "boolean", default: false }, help: { type: "boolean" },
    } }));
  } catch { throw new InputError("Invalid arguments. Use --help for usage."); }
  if (values.help) return { help: true };
  if (!/^[a-z][a-z\d_-]{0,60}$/i.test(values.db || "") || ["admin","config","local"].includes(values.db.toLowerCase())) {
    throw new InputError("Provide a named local application database with --db.");
  }
  if (!/^\d{1,5}$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new InputError("Invalid local port.");
  if (Boolean(values.role?.length) === Boolean(values.map)) throw new InputError("Use explicit --role IDs or one reviewed --map file.");
  let pairs;
  if (values.map) {
    let map;
    try { map = JSON.parse(await fs.readFile(values.map, "utf8")); } catch { throw new InputError("Cannot read the reviewed JSON map."); }
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new InputError("The reviewed map must be a JSON object.");
    pairs = Object.entries(map);
  } else {
    pairs = values.role.map(id => [id, null]);
  }
  if (!pairs.length) throw new InputError("Select at least one reviewed role.");
  const selected = new Map();
  for (const [id, category] of pairs) {
    if (!/^[\da-f]{24}$/i.test(id)) throw new InputError("Invalid role ID in selection.");
    if (values.map && !categories.includes(category)) throw new InputError("Unsupported target project category.");
    const normalized = id.toLowerCase();
    if (selected.has(normalized) && selected.get(normalized) !== category) throw new InputError("Conflicting categories for a role.");
    selected.set(normalized, category);
  }
  return { port: Number(values.port), db: values.db, write: values.write, selected };
}

async function prepareRole(id, reviewedCategory, session) {
  const existing = await Opportunity.exists({ workPositionId: id }).session(session);
  if (existing) return { roleId: id, result: "already_linked" };
  const role = await WorkPosition.findById(id).select("title category active serviceId").session(session).lean();
  if (!role?.active) return { roleId: id, result: "inactive_or_missing" };
  const sourceCategory = String(role.category || "").trim().toLowerCase();
  const sourceName = (sourceCategory + " " + (role.title || "")).replace(/[_-]/g, " ");
  if (accountProduct.test(sourceName)) return { roleId: id, result: "excluded_legacy_product" };
  if (role.serviceId) {
    const origin = await Service.findById(role.serviceId).select("category subcategory").session(session).lean();
    if (!origin || !legacyProjectCategories.has(origin.category) || accountProduct.test(String(origin.subcategory || "").replace(/[_-]/g, " "))) {
      return { roleId: id, result: "excluded_legacy_product" };
    }
  }
  const category = reviewedCategory || sourceCategory;
  if (!categories.includes(category)) return { roleId: id, result: "needs_category_mapping" };
  if (!role.title?.trim() || role.title.trim().length > 160) return { roleId: id, result: "needs_title_review" };
  if (!session) return { roleId: id, category, result: "would_create" };

  // Serialize with role deactivation, application admission and manual admin linking.
  const lock = await WorkPosition.updateOne({ _id: id, active: true }, { $inc: { applicationRevision: 1 } }, { session, timestamps: false });
  if (!lock.matchedCount) return { roleId: id, result: "inactive_or_missing" };
  await Opportunity.create([{
    workPositionId: id, title: role.title.trim(), category, status: "draft", applyEnabled: true,
    preserveRoleUntilPublished: true, rentEnabled: false, buyEnabled: false, rightsConfirmed: false,
  }], { session, ordered: true });
  return { roleId: id, category, result: "created" };
}

async function prepareDrafts(selected, write) {
  if (write) {
    await Opportunity.collection.createIndex({ workPositionId: 1 }, {
      unique: true, partialFilterExpression: { workPositionId: { $type: "objectId" } },
    });
  }
  const results = [];
  for (const [id, category] of selected) {
    try {
      const result = write ? await Opportunity.db.transaction(session => prepareRole(id, category, session)) :
        await prepareRole(id, category, null);
      results.push(result);
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.workPositionId || !await Opportunity.exists({ workPositionId: id })) throw error;
      results.push({ roleId: id, result: "already_linked" });
    }
  }
  return { mode: write ? "write" : "dry-run", results };
}

async function main() {
  const options = await readCommand(process.argv.slice(2));
  if (options.help) return console.log(usage);
  try {
    await mongoose.connect(`mongodb://127.0.0.1:${options.port}/${options.db}?directConnection=true`, {
      autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
    });
    console.log(JSON.stringify(await prepareDrafts(options.selected, options.write), null, 2));
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof InputError ? error.message : "Draft preparation failed. Check the local replica set and unique role index; rerunning skips previously linked roles.");
  process.exitCode = 1;
});
