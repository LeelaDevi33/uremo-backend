// PayPal Orders v2 and Webhooks v1. All provider calls use a fixed PayPal origin.
function status() {
  const mode = process.env.PAYPAL_MODE || "sandbox";
  const webhookConfigured = Boolean(process.env.PAYPAL_WEBHOOK_ID?.trim());
  const credentials = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_ID"].every(key => process.env[key]?.trim());
  const allowedMode = ["sandbox", "live"].includes(mode) &&
    (process.env.UREMO_ENVIRONMENT !== "staging" || mode === "sandbox") &&
    (process.env.UREMO_ENVIRONMENT !== "production" || mode === "live") &&
    (process.env.NODE_ENV !== "production" || process.env.UREMO_ENVIRONMENT === "staging" || mode === "live");
  return { mode: mode === "live" ? "live" : "sandbox", webhookConfigured, configured: Boolean(allowedMode && credentials && webhookConfigured) };
}
const host = () => status().mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
function validApprovalURL(value) {
  try {
    const url = new URL(value);
    const domain = status().mode === "live" ? "paypal.com" : "sandbox.paypal.com";
    return url.protocol === "https:" && [domain, "www." + domain].includes(url.host) && !url.password && !url.username;
  } catch { return false; }
}
async function request(path, token, body, id) {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (id) headers["PayPal-Request-Id"] = id;
  const response = await fetch(host() + path, { method: body ? "POST" : "GET", headers,
    body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error("PayPal request failed"), { providerStatus: response.status });
  return response.json();
}
async function authorize() {
  const credentials = process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_CLIENT_SECRET;
  const response = await fetch(host() + "/v1/oauth2/token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Authorization: "Basic " + Buffer.from(credentials).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials" });
  if (!response.ok) throw new Error("PayPal authentication failed");
  const { access_token: token } = await response.json();
  if (!token) throw new Error("PayPal authentication failed");
  return token;
}
module.exports = {
  status, validApprovalURL, authorize,
  create: (token, body, id) => request("/v2/checkout/orders", token, body, id),
  read: (token, id) => request("/v2/checkout/orders/" + encodeURIComponent(id), token),
  capture: (token, id, key) => request("/v2/checkout/orders/" + encodeURIComponent(id) + "/capture", token, {}, key),
  verify: async (token, headers, event) => {
    const payload = { webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event };
    for (const field of ["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time"]) {
      const value = headers["paypal-" + field.replaceAll("_", "-")];
      if (typeof value !== "string" || !value || value.length > 1500) return false;
      payload[field] = value;
    }
    const result = await request("/v1/notifications/verify-webhook-signature", token, payload);
    return result.verification_status === "SUCCESS";
  },
};
