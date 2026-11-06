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
async function specializationRoles(roles, session = null) {
  const ids = roles.map(r => r.serviceId).filter(Boolean);
  const origins = ids.length ? await Service.find({ _id: { $in: ids } }).select("title category subcategory").session(session).lean() : [];
  const services = new Map(origins.map(s => [String(s._id), s]));
  return roles.filter(role => {
    const source = services.get(String(role.serviceId));
    return !productLabel(role) && (!role.serviceId || Boolean(source && !productLabel(source)));
  });
}
module.exports = { specializationRoles };
