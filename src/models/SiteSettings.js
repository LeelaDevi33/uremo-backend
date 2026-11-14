const mongoose = require("mongoose");

const simpleText = {
  type: String,
  trim: true,
  default: "",
};

const faqItemSchema = new mongoose.Schema(
  {
    q: simpleText,
    a: simpleText,
  },
  { _id: false }
);

const titleDescSchema = new mongoose.Schema(
  {
    title: simpleText,
    desc: simpleText,
  },
  { _id: false }
);

const paymentUiValidationTextsSchema = new mongoose.Schema(
  {
    copyFailedText: simpleText,
    paymentDetailsCopiedText: simpleText,
    selectMethodRequiredText: simpleText,
    proofRequiredText: simpleText,
    invalidFileTypeText: simpleText,
    fileTooLargeText: simpleText,
    submitFailedText: simpleText,
  },
  { _id: false }
);

const paymentUiSchema = new mongoose.Schema(
  {
    loadingText: simpleText,
    validationTexts: {
      type: paymentUiValidationTextsSchema,
      default: {},
    },
  },
  { _id: false }
);

const ordersDetailsChatSchema = new mongoose.Schema(
  {
    inputPlaceholder: simpleText,
    sendButtonText: simpleText,
    sendingButtonText: simpleText,
    hintText: simpleText,
    emptyStateText: simpleText,
    emptyTitle: simpleText,
    emptySubtitle: simpleText,
  },
  { _id: false }
);

const ordersDetailsSchema = new mongoose.Schema(
  {
    chat: {
      type: ordersDetailsChatSchema,
      default: {},
    },
  },
  { _id: false }
);

const ordersSchema = new mongoose.Schema(
  {
    details: {
      type: ordersDetailsSchema,
      default: {},
    },
  },
  { _id: false }
);

const applyWorkUiSchema = new mongoose.Schema(
  {
    faqTitle: simpleText,
  },
  { _id: false }
);

const siteSettingsSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: "main",
      unique: true,
      index: true,
    },

    // =========================
    // CMS_FULL_STACK_PACK_02 (SiteSettings v2)
    // =========================
    site: {
      brandName: simpleText,
      bannerText: simpleText,
    },
    marketplace: {
      rolesTitle: { ...simpleText, maxlength: 100 },
      rolesIntro: { ...simpleText, maxlength: 300 },
      rentTitle: { ...simpleText, maxlength: 100 },
      rentIntro: { ...simpleText, maxlength: 300 },
      buyTitle: { ...simpleText, maxlength: 100 },
      buyIntro: { ...simpleText, maxlength: 300 },
    },

    support: {
      whatsappNumber: simpleText,
      supportEmail: simpleText,
      emailVisible: { type: Boolean },
    },

    footer: {
      disclaimer: simpleText,
      dataSafetyNote: simpleText,
    },

    landing: {
      heroTitle: simpleText,
      heroSubtitle: simpleText,
      ctaPrimaryText: simpleText,
      ctaSecondaryText: simpleText,
      features: { type: [titleDescSchema], default: [] },
      popularTitle: simpleText,
      popularSubtitle: simpleText,
      finalCtaTitle: simpleText,
      finalCtaSubtitle: simpleText,
    },

    payment: {
      beginnerSteps: { type: [titleDescSchema], default: [] },
      acceptedProofText: simpleText,
      successRedirectText: simpleText,
      ui: { type: paymentUiSchema, default: {} },
      faq: { type: [faqItemSchema], default: [] },
    },

    orders: { type: ordersSchema, default: {} },

    services: {
      globalFaq: { type: [faqItemSchema], default: [] },
      trustBlockText: simpleText,
    },

    orderSupport: {
      quickReplies: { type: [String], default: [] },
      supportGuidelines: simpleText,
      guidelinesText: simpleText,
    },

    applyWork: {
      faq: { type: [faqItemSchema], default: [] },
      ui: { type: applyWorkUiSchema, default: {} },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date },
  },
  { minimize: false }
);

module.exports = mongoose.model("SiteSettings", siteSettingsSchema);
