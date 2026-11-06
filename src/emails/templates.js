function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function humanizeCategory(category) {
  const c = String(category || "").trim();
  if (!c) return "General";
  return c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || "https://uremo.online").replace(
    /\/$/,
    "",
  );
}

function baseLayout({ title, preheader, bodyHtml }) {
  const safeTitle = escapeHtml(title);
  const safePreheader = escapeHtml(preheader || "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#070A12;color:#E5E7EB;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${safePreheader}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#070A12;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;">
            <tr>
              <td style="padding:0 0 14px 0;">
                <div style="font-weight:700;letter-spacing:0.2px;font-size:14px;color:#A7B0C0;">UREMO</div>
              </td>
            </tr>

            <tr>
              <td style="border:1px solid rgba(255,255,255,0.10);border-radius:18px;background:linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03));padding:22px;">
                ${bodyHtml}
              </td>
            </tr>

            <tr>
              <td style="padding:14px 4px 0 4px;color:#94A3B8;font-size:12px;line-height:18px;">
                <div style="margin-bottom:6px;">This is an automated message from UREMO.</div>
                <div>If you did not request this, you can ignore this email.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function primaryButton({ href, label }) {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `
    <a href="${safeHref}" target="_blank" rel="noreferrer" style="display:inline-block;background:#7C3AED;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:12px;">
      ${safeLabel}
    </a>
  `;
}

function kvRow(label, value) {
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
        <div style="color:#93A4B8;font-size:12px;">${escapeHtml(label)}</div>
        <div style="color:#E5E7EB;font-size:14px;font-weight:600;">${escapeHtml(
          value,
        )}</div>
      </td>
    </tr>
  `;
}

function welcomeEmail(recipient) {
  const name = typeof recipient === "string" ? recipient.split("@")[0] : recipient?.name;
  return baseLayout({
    title: "Welcome to UREMO",
    preheader: "Find a project or apply for an open role.",
    bodyHtml: `
      <h1>Welcome to UREMO</h1>
      <p>Hi ${escapeHtml(name || "there")}, your account is ready. Browse open roles and projects. Each listing shows whether you can apply, rent for a fixed term or buy exclusive access.</p>
      ${primaryButton({ href: `${getFrontendUrl()}/explore-services`, label: "Explore opportunities" })}
    `,
  });
}

function paymentPendingReminder(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const payUrl = `${getFrontendUrl()}/payment/${encodeURIComponent(orderId)}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Complete your payment to continue</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Your order is reserved and awaiting payment. Upload proof to start verification.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("Status", "Payment Pending")}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: payUrl,
      label: "Go to Payment",
    })}</div>
  `;

  return baseLayout({
    title: "Payment pending reminder",
    preheader: "Complete your payment to start verification.",
    bodyHtml,
  });
}

function paymentSubmitted(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const ordersUrl = `${getFrontendUrl()}/orders/${encodeURIComponent(orderId)}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Payment submitted</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      We received your payment proof. Our team will verify it and update your order.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("Status", "Awaiting Verification")}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: ordersUrl,
      label: "View Order",
    })}</div>
  `;

  return baseLayout({
    title: "Payment submitted",
    preheader: "Payment proof received — verification in progress.",
    bodyHtml,
  });
}

function paymentVerified(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const ordersUrl = `${getFrontendUrl()}/orders/${encodeURIComponent(orderId)}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Payment verified</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Good news — your payment has been verified. Your order is now processing.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("Status", "Processing")}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: ordersUrl,
      label: "View Order",
    })}</div>
  `;

  return baseLayout({
    title: "Payment verified",
    preheader: "Payment verified — your order is processing.",
    bodyHtml,
  });
}

function orderStatusUpdated(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const status = String(o.status || o.newStatus || "updated");
  const ordersUrl = `${getFrontendUrl()}/orders/${encodeURIComponent(orderId)}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Order status updated</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Your order status changed. You can view the latest update in your order details.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("New Status", status)}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: ordersUrl,
      label: "View Order",
    })}</div>
  `;

  return baseLayout({
    title: "Order status updated",
    preheader: `Your order is now ${escapeHtml(status)}`,
    bodyHtml,
  });
}

function adminNewOrderAlert(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const userEmail =
    o?.userId?.email || o?.userEmail || o?.user?.email || "(unknown)";
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const adminUrl = `${getFrontendUrl()}/admin/orders/${encodeURIComponent(
    orderId,
  )}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Admin alert: new order</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      A new order was created and is awaiting payment.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("User", String(userEmail))}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("Status", String(o.status || "pending"))}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: adminUrl,
      label: "Open in Admin",
    })}</div>
  `;

  return baseLayout({
    title: "Admin: new order",
    preheader: "New order created — payment pending.",
    bodyHtml,
  });
}

function adminPaymentProofAlert(order) {
  const o = order || {};
  const orderId = String(o._id || o.id || "");
  const userEmail =
    o?.userId?.email || o?.userEmail || o?.user?.email || "(unknown)";
  const serviceTitle =
    o?.serviceId?.title || o?.serviceTitle || o?.service?.title || "Service";
  const adminUrl = `${getFrontendUrl()}/admin/orders/${encodeURIComponent(
    orderId,
  )}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Admin alert: payment proof submitted</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      A user submitted payment proof. Please review and verify.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("User", String(userEmail))}
      ${kvRow("Service", String(serviceTitle))}
      ${kvRow("Status", String(o.status || "waiting_user"))}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: adminUrl,
      label: "Review Payment",
    })}</div>
  `;

  return baseLayout({
    title: "Admin: payment proof submitted",
    preheader: "Payment proof submitted — review required.",
    bodyHtml,
  });
}

function adminNewApplicationAlert(app) {
  const a = app || {};
  const userEmail = a?.user?.email || a?.userEmail || "(unknown)";
  const category = humanizeCategory(a?.category);
  const adminUrl = `${getFrontendUrl()}/admin/apply-work`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Admin alert: new application</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      A new apply-to-work submission was received.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("User", String(userEmail))}
      ${kvRow("Category", String(category))}
    </table>
    <div style="margin-top:18px;">${primaryButton({
      href: adminUrl,
      label: "Open Applications",
    })}</div>
  `;

  return baseLayout({
    title: "Admin: new application",
    preheader: "New apply-to-work submission received.",
    bodyHtml,
  });
}

function paymentSubmittedEmail({ name, orderId, serviceTitle }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Payment proof received</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Hi ${escapeHtml(
        name || "there",
      )}, we received your payment proof. Our team will review it and update your order shortly.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", serviceTitle)}
      ${kvRow("Status", "Payment Submitted (Awaiting Verification)")}
    </table>
  `;

  return baseLayout({
    title: "Payment proof received",
    preheader: "We received your payment proof — review in progress.",
    bodyHtml,
  });
}

function orderStatusEmail({ name, orderId, serviceTitle, newStatus }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Order status updated</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Hi ${escapeHtml(name || "there")}, your order status has been updated.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", serviceTitle)}
      ${kvRow("New Status", newStatus)}
    </table>
  `;

  return baseLayout({
    title: "Order status updated",
    preheader: `Your order status is now ${escapeHtml(newStatus)}`,
    bodyHtml,
  });
}

function applicationSubmittedEmail({ name, category }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Application submitted</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      Hi ${escapeHtml(
        name || "there",
      )}, your application has been received. Our team reviews applications manually.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("Category", humanizeCategory(category))}
      ${kvRow("Status", "Submitted (Under Review)")}
    </table>
  `;

  return baseLayout({
    title: "Application submitted",
    preheader: "Your application has been received and is under review.",
    bodyHtml,
  });
}

function adminPaymentAlertEmail({ userEmail, orderId, serviceTitle }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Admin alert: payment proof submitted</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      A user submitted payment proof. Please review and verify.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("User", userEmail)}
      ${kvRow("Order ID", orderId)}
      ${kvRow("Service", serviceTitle)}
    </table>
  `;

  return baseLayout({
    title: "Admin: payment proof submitted",
    preheader: "Payment proof submitted — review required.",
    bodyHtml,
  });
}

function adminApplicationAlertEmail({ userEmail, category }) {
  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;color:#FFFFFF;">Admin alert: new application</h1>
    <p style="margin:0 0 14px 0;color:#B6C2D6;font-size:14px;line-height:22px;">
      A new apply-to-work submission was received.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:8px;">
      ${kvRow("User", userEmail)}
      ${kvRow("Category", humanizeCategory(category))}
    </table>
  `;

  return baseLayout({
    title: "Admin: new application",
    preheader: "New apply-to-work submission received.",
    bodyHtml,
  });
}

module.exports = {
  // New pack API
  welcomeEmail,
  paymentPendingReminder,
  paymentSubmitted,
  paymentVerified,
  orderStatusUpdated,
  adminNewOrderAlert,
  adminPaymentProofAlert,
  adminNewApplicationAlert,

  // Backwards-compatible exports (existing controllers/pages)
  welcomeEmailLegacy: welcomeEmail,
  paymentSubmittedEmail,
  orderStatusEmail,
  applicationSubmittedEmail,
  adminPaymentAlertEmail,
  adminApplicationAlertEmail,
};
