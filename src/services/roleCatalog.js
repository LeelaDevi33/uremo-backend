const Service = require("../models/Service");

// Exact historical product identifiers; bespoke employment specializations
// such as financial analyst and banking researcher remain valid.
const retired = new Set(["forex_crypto", "banks_gateways_wallets", "banks_wallets", "crypto_accounts",
  "forex_accounts", "rentals", "forex_platform_creation", "crypto_platform_creation", "banks",
  "payment_gateways", "wallets", "whatsapp_business_verified", "linkedin_premium_account",
  "social_media_verified", "email_accounts", "fresh_account", "already_onboarded"]);
const key = value => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
function productLabel(record) {
  return [record.category, record.subcategory, record.title].some(value => retired.has(key(value))) ||
    /^(?:(?:buy|sell|rent|verified|fresh)\s+)?(?:bank|forex|crypto|trading|linkedin|whatsapp|paypal)\s+accounts?(?:\s+(?:sale|rental|for sale))?$/i.test(record.title || "");
}
const catalogFields = "title category serviceId description requirements";
const normalizedText = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

function historicalBriefReason(role) {
  const description = normalizedText(role.description);
  if (description === "test position for patch_44 multi-job validation") {
    return "An internal QA fixture is excluded from the worker directory.";
  }
  if (description.includes("without getting detected their ai detection system") &&
      normalizedText(role.requirements).includes("onboarded to an account for screening test")) {
    return "This historical brief describes a third-party account service. Replace it with an authorized worker specialization to publish.";
  }
}

async function directoryExclusions(roles, session = null) {
  const ids = roles.map(r => r.serviceId).filter(Boolean);
  const origins = ids.length ? await Service.find({ _id: { $in: ids } }).select("title category subcategory").session(session).lean() : [];
  const services = new Map(origins.map(s => [String(s._id), s]));
  const exclusions = new Map();
  for (const role of roles) {
    const source = services.get(String(role.serviceId));
    const reason = historicalBriefReason(role) ||
      (productLabel(role) || (role.serviceId && (!source || productLabel(source))) ?
        "This record belongs to a retired or unavailable service." : null);
    if (reason) exclusions.set(String(role._id), reason);
  }
  return exclusions;
}

async function specializationRoles(roles, session = null) {
  const exclusions = await directoryExclusions(roles, session);
  return roles.filter(role => !exclusions.has(String(role._id)));
}
module.exports = { catalogFields, directoryExclusions, specializationRoles };
