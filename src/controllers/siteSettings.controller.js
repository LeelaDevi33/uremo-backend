const SiteSettings = require("../models/SiteSettings");

const DEFAULTS = {
  marketplace: {
    rolesTitle: "Open roles",
    rolesIntro: "Find a specialization that fits your skills. Apply for free to qualify for matching projects.",
    rentTitle: "Rent projects",
    rentIntro: "Rent a specific project for a fixed term after qualifying for its specialization.",
    buyTitle: "Full Access projects",
    buyIntro: "Get permanent, exclusive access to a specific project with one payment. Anyone can purchase.",
  },
  site: {
    brandName: "UREMO",
    bannerText:
      "⚠️ All services are processed manually. Verification & approval may take time.",
  },
  support: {
    whatsappNumber: "",
    supportEmail: "",
  },
  footer: {
    disclaimer:
      "UREMO is an independent service provider. We are not affiliated with, endorsed by, or sponsored by any third-party platforms.",
    dataSafetyNote:
      "Verification outcomes depend on platform rules and policies. UREMO does not store sensitive login credentials or personal data openly.",
  },
  landing: {
    heroTitle: "Verified Digital Onboarding & Marketplace",
    heroSubtitle:
      "Buy trusted onboarding, KYC, and verification assistance services. Track orders with human verification and admin support.",
    ctaPrimaryText: "Browse services",
    ctaSecondaryText: "How it works",
    features: [
      {
        title: "Manual verification",
        desc: "Real human checks — not bots — to reduce risk and delays.",
      },
      {
        title: "Order tracking",
        desc: "Pay, submit proof, and track status in your dashboard.",
      },
      {
        title: "Support chat",
        desc: "Message support directly from your order page anytime.",
      },
    ],
    popularTitle: "Popular services",
    popularSubtitle: "Start with our most-requested manual operations.",
    finalCtaTitle: "Ready to start?",
    finalCtaSubtitle:
      "Create an account, reserve a service, and complete payment to begin manual verification.",
  },
  payment: {
    beginnerSteps: [
      {
        title: "Reserve your service",
        desc: "Choose a service and place an order.",
      },
      {
        title: "Pay securely",
        desc: "Submit your payment reference and proof.",
      },
      { title: "Get verified", desc: "We verify manually and start delivery." },
    ],
    acceptedProofText:
      "Accepted proof: Screenshot/PDF with transaction ID, amount, and receiver details.",
    successRedirectText:
      "Payment received. We’ll verify and update your order shortly.",
    ui: {
      loadingText: "Loading…",
      validationTexts: {
        copyFailedText: "Copy failed",
        paymentDetailsCopiedText: "Payment details copied",
        selectMethodRequiredText: "Please select a payment method",
        proofRequiredText: "Please upload payment proof",
        invalidFileTypeText: "Only PNG/JPG/WEBP/PDF allowed",
        fileTooLargeText: "File too large (max 10MB)",
        submitFailedText: "Failed to submit proof",
      },
    },
    faq: [
      {
        q: "How long does verification take?",
        a: "Usually 5–60 minutes. During peak time it may take longer.",
      },
      {
        q: "What proof is accepted?",
        a: "Screenshot/PDF with transaction ID, amount, and receiver details.",
      },
      {
        q: "What if I uploaded wrong proof?",
        a: "Message Support using Order Chat and re-upload if needed.",
      },
    ],
  },
  orders: {
    details: {
      chat: {
        inputPlaceholder: "Type a message…",
        sendButtonText: "Send",
        sendingButtonText: "Sending…",
        hintText: "Support replies from admin will appear here.",
        emptyStateText: "Use a quick reply to start the conversation.",
        emptyTitle: "No messages yet. Support will reply here.",
        emptySubtitle: "Use a quick reply to start the conversation.",
      },
    },
  },
  services: {
    globalFaq: [],
    trustBlockText:
      "UREMO delivers manual operations with human verification and transparent order tracking.",
  },
  orderSupport: {
    quickReplies: [
      "I have paid, please verify.",
      "When will my service be delivered?",
      "I need urgent delivery.",
    ],
    supportGuidelines:
      "Share your order issue and any relevant proof/reference. Support replies within working hours.",
    guidelinesText:
      "Share your order issue and any relevant proof/reference. Support replies within working hours.",
  },
  applyWork: {
    faq: [
      {
        q: "How long does approval take?",
        a: "24–72 hours depending on openings.",
      },
      { q: "What resume format is accepted?", a: "PDF is preferred." },
    ],
    ui: {
      faqTitle: "Apply-to-work FAQ",
    },
  },
};

const clampString = (value, maxLen) => {
  if (typeof value !== "string") return "";
  const out = value.trim();
  if (!out) return "";
  if (out.length <= maxLen) return out;
  return out.slice(0, maxLen);
};

const sanitizeFaqArray = (input, opts) => {
  const maxItems = opts?.maxItems ?? 25;
  const maxQ = opts?.maxQ ?? 200;
  const maxA = opts?.maxA ?? 1200;

  if (!Array.isArray(input)) return [];

  const cleaned = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const q = clampString(item.q, maxQ);
    const a = clampString(item.a, maxA);
    if (!q || !a) continue;
    cleaned.push({ q, a });
    if (cleaned.length >= maxItems) break;
  }
  return cleaned;
};

const sanitizeTitleDescArray = (input, opts) => {
  const maxItems = opts?.maxItems ?? 12;
  const maxTitle = opts?.maxTitle ?? 80;
  const maxDesc = opts?.maxDesc ?? 200;

  if (!Array.isArray(input)) return [];
  const cleaned = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const title = clampString(item.title, maxTitle);
    const desc = clampString(item.desc, maxDesc);
    if (!title || !desc) continue;
    cleaned.push({ title, desc });
    if (cleaned.length >= maxItems) break;
  }
  return cleaned;
};

const sanitizeStringArray = (input, opts) => {
  const maxItems = opts?.maxItems ?? 10;
  const maxLen = opts?.maxLen ?? 120;
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    const v = clampString(raw, maxLen);
    if (!v) continue;
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
};

const hasOwn = (obj, key) =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const isPlainSettingsObject = (value) => {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  return true;
};

const flattenForSet = (value, prefix = "") => {
  if (!isPlainSettingsObject(value)) return {};
  const out = {};

  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainSettingsObject(val)) {
      Object.assign(out, flattenForSet(val, path));
      continue;
    }
    out[path] = val;
  }

  return out;
};

const ensureMainSettings = async () => {
  const existing = await SiteSettings.findOne({ singletonKey: "main" });
  if (existing) return existing;

  try {
    return await SiteSettings.findOneAndUpdate({ singletonKey: "main" },
      { $setOnInsert: { ...DEFAULTS, updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return SiteSettings.findOne({ singletonKey: "main" });
  }
};

const revisionOf = doc => (doc.updatedAt || doc._id.getTimestamp()).toISOString();
const conflict = () => Object.assign(new Error("Settings changed. Reload the current settings before saving your edits."), { status: 409 });

async function settingsWrite(expected) {
  const doc = await ensureMainSettings();
  const revision = revisionOf(doc);
  if (expected !== undefined && expected !== revision) throw conflict();
  return {
    filter: { _id: doc._id, updatedAt: doc.updatedAt || null },
    updatedAt: new Date(Math.max(Date.now(), Date.parse(revision) + 1)),
  };
}

const validSupportEmail = value =>
  value.length <= 120 && /^[^\s@<>?#,;:]+@[^\s@<>?#,;:]+\.[^\s@<>?#,;:]+$/.test(value);

const publicProjection = (doc) => {
  // Backward compatibility: support older keys (bannerText + faq.*)
  const legacyBannerText = String(doc?.bannerText || "").trim();

  const site = {
    brandName:
      String(doc?.site?.brandName || "").trim() || DEFAULTS.site.brandName,
    bannerText:
      String(doc?.site?.bannerText || "").trim() ||
      legacyBannerText ||
      DEFAULTS.site.bannerText,
  };

  const address = String(doc?.support?.supportEmail || "").trim();
  // An old installation default pointed to an unconfigured mailbox. Preserve it
  // for editors and publish it only after they explicitly enable the address.
  const emailVisible = validSupportEmail(address) &&
    (doc?.support?.emailVisible ?? address.toLowerCase() !== "support@uremo.online");
  const support = {
    whatsappNumber:
      String(doc?.support?.whatsappNumber || "").trim() ||
      DEFAULTS.support.whatsappNumber,
    supportEmail: emailVisible ? address : "",
    emailVisible,
  };

  const footer = {
    disclaimer:
      String(doc?.footer?.disclaimer || "").trim() ||
      DEFAULTS.footer.disclaimer,
    dataSafetyNote:
      String(doc?.footer?.dataSafetyNote || "").trim() ||
      DEFAULTS.footer.dataSafetyNote,
  };

  const landing = {
    heroTitle:
      String(doc?.landing?.heroTitle || "").trim() ||
      DEFAULTS.landing.heroTitle,
    heroSubtitle:
      String(doc?.landing?.heroSubtitle || "").trim() ||
      DEFAULTS.landing.heroSubtitle,
    ctaPrimaryText:
      String(doc?.landing?.ctaPrimaryText || "").trim() ||
      DEFAULTS.landing.ctaPrimaryText,
    ctaSecondaryText:
      String(doc?.landing?.ctaSecondaryText || "").trim() ||
      DEFAULTS.landing.ctaSecondaryText,
    features:
      Array.isArray(doc?.landing?.features) && doc.landing.features.length
        ? doc.landing.features
        : DEFAULTS.landing.features,
    popularTitle:
      String(doc?.landing?.popularTitle || "").trim() ||
      DEFAULTS.landing.popularTitle,
    popularSubtitle:
      String(doc?.landing?.popularSubtitle || "").trim() ||
      DEFAULTS.landing.popularSubtitle,
    finalCtaTitle:
      String(doc?.landing?.finalCtaTitle || "").trim() ||
      DEFAULTS.landing.finalCtaTitle,
    finalCtaSubtitle:
      String(doc?.landing?.finalCtaSubtitle || "").trim() ||
      DEFAULTS.landing.finalCtaSubtitle,
  };

  const legacyPaymentFaq =
    Array.isArray(doc?.faq?.payment) && doc.faq.payment.length
      ? doc.faq.payment
      : [];
  const legacyApplyWorkFaq =
    Array.isArray(doc?.faq?.applyWork) && doc.faq.applyWork.length
      ? doc.faq.applyWork
      : [];
  const legacyGlobalFaq =
    Array.isArray(doc?.faq?.global) && doc.faq.global.length
      ? doc.faq.global
      : [];

  const payment = {
    beginnerSteps:
      Array.isArray(doc?.payment?.beginnerSteps) &&
      doc.payment.beginnerSteps.length
        ? doc.payment.beginnerSteps
        : DEFAULTS.payment.beginnerSteps,
    acceptedProofText:
      String(doc?.payment?.acceptedProofText || "").trim() ||
      DEFAULTS.payment.acceptedProofText,
    successRedirectText:
      String(doc?.payment?.successRedirectText || "").trim() ||
      DEFAULTS.payment.successRedirectText,
    faq:
      Array.isArray(doc?.payment?.faq) && doc.payment.faq.length
        ? doc.payment.faq
        : legacyPaymentFaq.length
        ? legacyPaymentFaq
        : DEFAULTS.payment.faq,
    ui: {
      loadingText:
        String(doc?.payment?.ui?.loadingText || "").trim() ||
        DEFAULTS.payment.ui.loadingText,
      validationTexts: {
        copyFailedText:
          String(
            doc?.payment?.ui?.validationTexts?.copyFailedText || ""
          ).trim() || DEFAULTS.payment.ui.validationTexts.copyFailedText,
        paymentDetailsCopiedText:
          String(
            doc?.payment?.ui?.validationTexts?.paymentDetailsCopiedText || ""
          ).trim() ||
          DEFAULTS.payment.ui.validationTexts.paymentDetailsCopiedText,
        selectMethodRequiredText:
          String(
            doc?.payment?.ui?.validationTexts?.selectMethodRequiredText || ""
          ).trim() ||
          DEFAULTS.payment.ui.validationTexts.selectMethodRequiredText,
        proofRequiredText:
          String(
            doc?.payment?.ui?.validationTexts?.proofRequiredText || ""
          ).trim() || DEFAULTS.payment.ui.validationTexts.proofRequiredText,
        invalidFileTypeText:
          String(
            doc?.payment?.ui?.validationTexts?.invalidFileTypeText || ""
          ).trim() || DEFAULTS.payment.ui.validationTexts.invalidFileTypeText,
        fileTooLargeText:
          String(
            doc?.payment?.ui?.validationTexts?.fileTooLargeText || ""
          ).trim() || DEFAULTS.payment.ui.validationTexts.fileTooLargeText,
        submitFailedText:
          String(
            doc?.payment?.ui?.validationTexts?.submitFailedText || ""
          ).trim() || DEFAULTS.payment.ui.validationTexts.submitFailedText,
      },
    },
  };

  const orders = {
    details: {
      chat: {
        inputPlaceholder:
          String(doc?.orders?.details?.chat?.inputPlaceholder || "").trim() ||
          DEFAULTS.orders.details.chat.inputPlaceholder,
        sendButtonText:
          String(doc?.orders?.details?.chat?.sendButtonText || "").trim() ||
          DEFAULTS.orders.details.chat.sendButtonText,
        sendingButtonText:
          String(doc?.orders?.details?.chat?.sendingButtonText || "").trim() ||
          DEFAULTS.orders.details.chat.sendingButtonText,
        hintText:
          String(doc?.orders?.details?.chat?.hintText || "").trim() ||
          DEFAULTS.orders.details.chat.hintText,
        emptyStateText:
          String(doc?.orders?.details?.chat?.emptyStateText || "").trim() ||
          DEFAULTS.orders.details.chat.emptyStateText,
        emptyTitle:
          String(doc?.orders?.details?.chat?.emptyTitle || "").trim() ||
          DEFAULTS.orders.details.chat.emptyTitle,
        emptySubtitle:
          String(doc?.orders?.details?.chat?.emptySubtitle || "").trim() ||
          DEFAULTS.orders.details.chat.emptySubtitle,
      },
    },
  };

  const services = {
    globalFaq:
      Array.isArray(doc?.services?.globalFaq) && doc.services.globalFaq.length
        ? doc.services.globalFaq
        : legacyGlobalFaq.length
        ? legacyGlobalFaq
        : DEFAULTS.services.globalFaq,
    trustBlockText:
      String(doc?.services?.trustBlockText || "").trim() ||
      DEFAULTS.services.trustBlockText,
  };

  const orderSupport = {
    quickReplies:
      Array.isArray(doc?.orderSupport?.quickReplies) &&
      doc.orderSupport.quickReplies.length
        ? doc.orderSupport.quickReplies
        : DEFAULTS.orderSupport.quickReplies,
    supportGuidelines:
      String(doc?.orderSupport?.supportGuidelines || "").trim() ||
      DEFAULTS.orderSupport.supportGuidelines,
    guidelinesText:
      String(doc?.orderSupport?.guidelinesText || "").trim() ||
      String(doc?.orderSupport?.supportGuidelines || "").trim() ||
      DEFAULTS.orderSupport.guidelinesText,
  };

  const applyWork = {
    faq:
      Array.isArray(doc?.applyWork?.faq) && doc.applyWork.faq.length
        ? doc.applyWork.faq
        : legacyApplyWorkFaq.length
        ? legacyApplyWorkFaq
        : DEFAULTS.applyWork.faq,
    ui: {
      faqTitle:
        String(doc?.applyWork?.ui?.faqTitle || "").trim() ||
        DEFAULTS.applyWork.ui.faqTitle,
    },
  };

  return {
    site,
    marketplace: Object.fromEntries(Object.entries(DEFAULTS.marketplace).map(([key, fallback]) =>
      [key, String(doc?.marketplace?.[key] || "").trim() || fallback])),
    support,
    footer,
    landing,
    payment,
    orders,
    services,
    orderSupport,
    applyWork,
    updatedAt: doc?.updatedAt || null,
  };
};

exports.getPublicSettings = async (req, res) => {
  try {
    const doc = await ensureMainSettings();
    res.set("Cache-Control", "no-store");
    return res.json(publicProjection(doc));
  } catch (err) {
    return res.status(500).json({ message: err?.message || "Server error" });
  }
};

// Pure helper for internal callers (e.g., JarvisX) to reuse the exact public projection.
exports.getPublicSettingsObject = async () => {
  const doc = await ensureMainSettings();
  return publicProjection(doc);
};

exports.getAdminSettings = async (req, res) => {
  try {
    const doc = await ensureMainSettings();
    await doc.populate("updatedBy", "_id name email role");
    return res.set("Cache-Control", "private, no-store").json({ ...doc.toObject(), revision: revisionOf(doc) });
  } catch (err) {
    return res.status(500).json({ message: err?.message || "Server error" });
  }
};

// Pure helper for internal callers (e.g., JarvisX) to reuse the exact admin settings doc.
exports.getAdminSettingsObject = async () => {
  const doc = await ensureMainSettings();
  await doc.populate("updatedBy", "_id name email role");
  return doc;
};

// Internal helper for safe partial updates (deep-merge) used by JarvisX write executor.
// `patch` must be a plain object and is merged into the existing settings.
exports.applyAdminSettingsPatch = async ({ patch, updatedBy }) => {
  if (!isPlainSettingsObject(patch)) {
    const err = new Error("Invalid settings patch");
    err.status = 400;
    throw err;
  }

  const sizeCheck = clampSettingsJsonSize(patch, 200 * 1024);
  if (!sizeCheck.ok) {
    const err = new Error("Settings patch too large (max 200KB)");
    err.status = 413;
    throw err;
  }

  const write = await settingsWrite();

  const sanitizedPatch = stripSystemFieldsForMerge(patch);
  const update = deepMerge(
    {
      updatedAt: write.updatedAt,
      updatedBy: updatedBy || undefined,
    },
    sanitizedPatch
  );

  const flattened = flattenForSet(update);

  const updated = await SiteSettings.findOneAndUpdate(
    write.filter,
    { $set: flattened },
    { new: false, runValidators: true }
  );
  if (!updated) throw conflict();

  return true;
};

exports.updateAdminSettings = async (req, res) => {
  try {
    const body = req.body || {};

    const write = await settingsWrite(body.expectedRevision);

    // Accept legacy payload fields too.
    const legacyBannerText = clampString(body.bannerText, 240);

    const patch = {};
    if (hasOwn(body, "marketplace")) {
      if (!isPlainSettingsObject(body.marketplace)) return res.status(400).json({ message: "Invalid marketplace text" });
      patch.marketplace = {};
      for (const [key, value] of Object.entries(body.marketplace)) {
        if (!hasOwn(DEFAULTS.marketplace, key) || typeof value !== "string" || value.trim().length > (key.endsWith("Title") ? 100 : 300)) {
          return res.status(400).json({ message: "Invalid marketplace text" });
        }
        patch.marketplace[key] = value.trim();
      }
    }

    if (hasOwn(body, "site")) {
      patch.site = {};
      if (hasOwn(body.site, "brandName"))
        patch.site.brandName = clampString(body.site.brandName, 48);
      if (hasOwn(body.site, "bannerText") || hasOwn(body, "bannerText")) {
        patch.site.bannerText =
          clampString(body?.site?.bannerText, 240) || legacyBannerText;
      }
    }

    if (hasOwn(body, "support")) {
      if (!isPlainSettingsObject(body.support)) return res.status(400).json({ message: "Provide support settings" });
      patch.support = {};
      if (hasOwn(body.support, "whatsappNumber"))
        patch.support.whatsappNumber = clampString(
          body.support.whatsappNumber,
          32
        );
      if (hasOwn(body.support, "supportEmail")) {
        const value = body.support.supportEmail;
        if (typeof value !== "string" || (value.trim() && !validSupportEmail(value.trim()))) {
          return res.status(400).json({ message: "Enter a valid support email address" });
        }
        patch.support.supportEmail = value.trim();
      }
      if (hasOwn(body.support, "emailVisible")) {
        if (typeof body.support.emailVisible !== "boolean") return res.status(400).json({ message: "Choose whether to show the support email" });
        patch.support.emailVisible = body.support.emailVisible;
      }
    }

    if (hasOwn(body, "footer")) {
      patch.footer = {};
      if (hasOwn(body.footer, "disclaimer"))
        patch.footer.disclaimer = clampString(body.footer.disclaimer, 2000);
      if (hasOwn(body.footer, "dataSafetyNote"))
        patch.footer.dataSafetyNote = clampString(
          body.footer.dataSafetyNote,
          2000
        );
    }

    if (hasOwn(body, "landing")) {
      patch.landing = {};
      if (hasOwn(body.landing, "heroTitle"))
        patch.landing.heroTitle = clampString(body.landing.heroTitle, 120);
      if (hasOwn(body.landing, "heroSubtitle"))
        patch.landing.heroSubtitle = clampString(
          body.landing.heroSubtitle,
          300
        );
      if (hasOwn(body.landing, "ctaPrimaryText"))
        patch.landing.ctaPrimaryText = clampString(
          body.landing.ctaPrimaryText,
          32
        );
      if (hasOwn(body.landing, "ctaSecondaryText"))
        patch.landing.ctaSecondaryText = clampString(
          body.landing.ctaSecondaryText,
          32
        );
      if (hasOwn(body.landing, "features"))
        patch.landing.features = sanitizeTitleDescArray(body.landing.features, {
          maxItems: 8,
          maxTitle: 48,
          maxDesc: 140,
        });
      if (hasOwn(body.landing, "popularTitle"))
        patch.landing.popularTitle = clampString(body.landing.popularTitle, 64);
      if (hasOwn(body.landing, "popularSubtitle"))
        patch.landing.popularSubtitle = clampString(
          body.landing.popularSubtitle,
          160
        );
      if (hasOwn(body.landing, "finalCtaTitle"))
        patch.landing.finalCtaTitle = clampString(
          body.landing.finalCtaTitle,
          64
        );
      if (hasOwn(body.landing, "finalCtaSubtitle"))
        patch.landing.finalCtaSubtitle = clampString(
          body.landing.finalCtaSubtitle,
          220
        );
    }

    if (hasOwn(body, "payment")) {
      patch.payment = {};
      if (hasOwn(body.payment, "beginnerSteps"))
        patch.payment.beginnerSteps = sanitizeTitleDescArray(
          body.payment.beginnerSteps,
          {
            maxItems: 10,
            maxTitle: 48,
            maxDesc: 160,
          }
        );
      if (hasOwn(body.payment, "acceptedProofText"))
        patch.payment.acceptedProofText = clampString(
          body.payment.acceptedProofText,
          300
        );
      if (hasOwn(body.payment, "successRedirectText"))
        patch.payment.successRedirectText = clampString(
          body.payment.successRedirectText,
          220
        );
      if (hasOwn(body.payment, "faq"))
        patch.payment.faq = sanitizeFaqArray(body.payment.faq);

      if (hasOwn(body.payment, "ui")) {
        patch.payment.ui = {};
        if (hasOwn(body.payment.ui, "loadingText"))
          patch.payment.ui.loadingText = clampString(
            body.payment.ui.loadingText,
            80
          );

        const vt = body.payment?.ui?.validationTexts;
        if (
          hasOwn(body.payment.ui, "validationTexts") &&
          vt &&
          typeof vt === "object"
        ) {
          patch.payment.ui.validationTexts = {};
          if (hasOwn(vt, "copyFailedText"))
            patch.payment.ui.validationTexts.copyFailedText = clampString(
              vt.copyFailedText,
              120
            );
          if (hasOwn(vt, "paymentDetailsCopiedText"))
            patch.payment.ui.validationTexts.paymentDetailsCopiedText =
              clampString(vt.paymentDetailsCopiedText, 120);
          if (hasOwn(vt, "selectMethodRequiredText"))
            patch.payment.ui.validationTexts.selectMethodRequiredText =
              clampString(vt.selectMethodRequiredText, 140);
          if (hasOwn(vt, "proofRequiredText"))
            patch.payment.ui.validationTexts.proofRequiredText = clampString(
              vt.proofRequiredText,
              140
            );
          if (hasOwn(vt, "invalidFileTypeText"))
            patch.payment.ui.validationTexts.invalidFileTypeText = clampString(
              vt.invalidFileTypeText,
              140
            );
          if (hasOwn(vt, "fileTooLargeText"))
            patch.payment.ui.validationTexts.fileTooLargeText = clampString(
              vt.fileTooLargeText,
              140
            );
          if (hasOwn(vt, "submitFailedText"))
            patch.payment.ui.validationTexts.submitFailedText = clampString(
              vt.submitFailedText,
              140
            );
        }
      }
    }

    if (hasOwn(body, "orders")) {
      const chat = body?.orders?.details?.chat;
      if (isPlainSettingsObject(chat)) {
        patch.orders = { details: { chat: {} } };
        if (hasOwn(chat, "inputPlaceholder"))
          patch.orders.details.chat.inputPlaceholder = clampString(
            chat.inputPlaceholder,
            120
          );
        if (hasOwn(chat, "sendButtonText"))
          patch.orders.details.chat.sendButtonText = clampString(
            chat.sendButtonText,
            40
          );
        if (hasOwn(chat, "sendingButtonText"))
          patch.orders.details.chat.sendingButtonText = clampString(
            chat.sendingButtonText,
            40
          );
        if (hasOwn(chat, "hintText"))
          patch.orders.details.chat.hintText = clampString(chat.hintText, 180);
        if (hasOwn(chat, "emptyStateText"))
          patch.orders.details.chat.emptyStateText = clampString(
            chat.emptyStateText,
            180
          );
        if (hasOwn(chat, "emptyTitle"))
          patch.orders.details.chat.emptyTitle = clampString(
            chat.emptyTitle,
            180
          );
        if (hasOwn(chat, "emptySubtitle"))
          patch.orders.details.chat.emptySubtitle = clampString(
            chat.emptySubtitle,
            180
          );
      }
    }

    if (hasOwn(body, "services")) {
      patch.services = {};
      if (hasOwn(body.services, "globalFaq"))
        patch.services.globalFaq = sanitizeFaqArray(body.services.globalFaq);
      if (hasOwn(body.services, "trustBlockText"))
        patch.services.trustBlockText = clampString(
          body.services.trustBlockText,
          600
        );
    }

    if (hasOwn(body, "orderSupport")) {
      patch.orderSupport = {};
      if (hasOwn(body.orderSupport, "quickReplies"))
        patch.orderSupport.quickReplies = sanitizeStringArray(
          body.orderSupport.quickReplies,
          {
            maxItems: 10,
            maxLen: 80,
          }
        );

      const guidelinesText = clampString(
        body?.orderSupport?.guidelinesText,
        600
      );
      const supportGuidelines = clampString(
        body?.orderSupport?.supportGuidelines,
        600
      );

      if (hasOwn(body.orderSupport, "guidelinesText"))
        patch.orderSupport.guidelinesText = guidelinesText;
      if (hasOwn(body.orderSupport, "supportGuidelines"))
        patch.orderSupport.supportGuidelines = supportGuidelines;

      // Keep both keys in sync when either is provided.
      if (
        hasOwn(body.orderSupport, "guidelinesText") &&
        !hasOwn(body.orderSupport, "supportGuidelines")
      ) {
        patch.orderSupport.supportGuidelines = guidelinesText;
      }
      if (
        hasOwn(body.orderSupport, "supportGuidelines") &&
        !hasOwn(body.orderSupport, "guidelinesText")
      ) {
        patch.orderSupport.guidelinesText = supportGuidelines;
      }
    }

    if (hasOwn(body, "applyWork")) {
      patch.applyWork = {};
      if (hasOwn(body.applyWork, "faq"))
        patch.applyWork.faq = sanitizeFaqArray(body.applyWork.faq);
      if (hasOwn(body.applyWork, "ui")) {
        patch.applyWork.ui = {};
        if (hasOwn(body.applyWork.ui, "faqTitle"))
          patch.applyWork.ui.faqTitle = clampString(
            body.applyWork.ui.faqTitle,
            80
          );
      }
    }

    // Keep legacy fields so older frontends remain compatible if deployed.
    if (hasOwn(body, "bannerText")) patch.bannerText = legacyBannerText;
    if (hasOwn(body, "faq")) {
      patch.faq = {};
      if (hasOwn(body.faq, "global"))
        patch.faq.global = sanitizeFaqArray(body.faq.global);
      if (hasOwn(body.faq, "payment"))
        patch.faq.payment = sanitizeFaqArray(body.faq.payment);
      if (hasOwn(body.faq, "applyWork"))
        patch.faq.applyWork = sanitizeFaqArray(body.faq.applyWork);
      if (hasOwn(body.faq, "orderSupport"))
        patch.faq.orderSupport = sanitizeFaqArray(body.faq.orderSupport);
    }

    patch.updatedAt = write.updatedAt;
    patch.updatedBy = req.user?.id;

    const updateSet = flattenForSet(patch);

    const updated = await SiteSettings.findOneAndUpdate(
      write.filter,
      { $set: updateSet },
      { returnDocument: "after", runValidators: true }
    );

    if (!updated) throw conflict();
    await updated.populate("updatedBy", "_id name email role");
    return res.json({ ...updated.toObject(), revision: revisionOf(updated) });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err?.message || "Server error" });
  }
};

const deepMerge = (target, source) => {
  if (!isPlainSettingsObject(target) || !isPlainSettingsObject(source))
    return target;
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    if (isPlainSettingsObject(val)) {
      if (!isPlainSettingsObject(target[key])) target[key] = {};
      deepMerge(target[key], val);
      continue;
    }
    target[key] = val;
  }
  return target;
};

const stripSystemFieldsForMerge = (settings) => {
  if (!isPlainSettingsObject(settings)) return {};
  const out = JSON.parse(JSON.stringify(settings));
  delete out._id;
  delete out.__v;
  delete out.singletonKey;
  delete out.updatedAt;
  delete out.updatedBy;
  return out;
};

const clampSettingsJsonSize = (settings, maxBytes) => {
  try {
    const json = JSON.stringify(settings);
    const bytes = Buffer.byteLength(json, "utf8");
    return { ok: bytes <= maxBytes, bytes };
  } catch (e) {
    return { ok: false, bytes: 0, error: e };
  }
};

exports.getAdminSettingsRaw = async (req, res) => {
  try {
    const doc = await ensureMainSettings();
    return res.set("Cache-Control", "private, no-store").json({ settings: doc, revision: revisionOf(doc) });
  } catch (err) {
    return res.status(500).json({ message: err?.message || "Server error" });
  }
};

exports.putAdminSettingsRaw = async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body?.mode;
    const incoming = body?.settings;

    if (mode !== "merge" && mode !== "replace") {
      return res.status(400).json({
        message: "Invalid settings JSON",
        details: "mode must be 'merge' or 'replace'",
      });
    }

    if (!isPlainSettingsObject(incoming)) {
      return res.status(400).json({
        message: "Invalid settings JSON",
        details: "settings must be an object",
      });
    }

    const sizeCheck = clampSettingsJsonSize(incoming, 200 * 1024);
    if (!sizeCheck.ok) {
      return res.status(413).json({
        message: "Invalid settings JSON",
        details: `settings JSON too large (max 200KB)`,
      });
    }

    const write = await settingsWrite(body.expectedRevision);

    if (mode === "replace") {
      const nextDoc = { ...incoming };
      delete nextDoc._id;
      delete nextDoc.__v;
      nextDoc.singletonKey = "main";
      nextDoc.updatedAt = write.updatedAt;
      nextDoc.updatedBy = req.user?.id;

      const prior = await SiteSettings.findOneAndReplace(write.filter, nextDoc, {
        runValidators: true,
      });
      if (!prior) throw conflict();

      return res.json({
        message: "Settings updated",
        mode,
        updated: true,
      });
    }

    // merge mode
    const sanitizedIncoming = stripSystemFieldsForMerge(incoming);
    const update = deepMerge(
      {
        updatedAt: write.updatedAt,
        updatedBy: req.user?.id,
      },
      sanitizedIncoming
    );

    const flattened = flattenForSet(update);

    const prior = await SiteSettings.findOneAndUpdate(
      write.filter,
      { $set: flattened },
      { new: false, runValidators: true }
    );
    if (!prior) throw conflict();

    return res.json({
      message: "Settings updated",
      mode,
      updated: true,
    });
  } catch (err) {
    return res.status(err.status || 400).json({
      message: err.status === 409 ? err.message : "Invalid settings JSON",
      details: err?.message || "Unknown error",
    });
  }
};
