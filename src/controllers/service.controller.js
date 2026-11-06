const Service = require("../models/Service");
const {
  CATEGORY_ENUM,
  SUBCATEGORY_BY_CATEGORY,
  ALL_SUBCATEGORIES,
} = require("../models/Service");

// PATCH_38: Central action rules
const {
  getAllowedActionsForService,
  getEffectiveCategoryFromService,
} = require("../config/categoryActions");

// PATCH_106: Hard validation rules for service actions
const {
  validateServiceActions,
  autoCleanupInconsistencies,
} = require("../utils/serviceValidation");

function setNoCache(res) {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
}

const slugify = (str) => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};

// PATCH_17/21: Canonical filter definitions (matches vision 3-step flow)
const CANON_CATEGORIES = [
  { id: "microjobs", label: "Microjobs" },
  { id: "forex_crypto", label: "Forex / Crypto" },
  { id: "banks_gateways_wallets", label: "Banks / Gateways / Wallets" },
  // PATCH_21: Rentals category for account rental services
  { id: "rentals", label: "Rentals (Account Rental Services)" },
  { id: "general", label: "General" },
];

// PATCH_17: Two-path listing types
const CANON_LISTING_TYPES = [
  { id: "fresh_account", label: "Fresh Account (with screening assessment)" },
  {
    id: "already_onboarded",
    label: "Already Onboarded (Instant project-ready)",
  },
  { id: "general", label: "General" },
];

// Legacy service types (kept for backward compatibility)
const CANON_SERVICE_TYPES = [
  { id: "all", label: "All types" },
  { id: "fresh_profile", label: "Apply Fresh / KYC" },
  { id: "already_onboarded", label: "Already Onboarded" },
  { id: "interview_process", label: "Interview Process" },
  { id: "interview_passed", label: "Interview Passed" },
  { id: "general", label: "General" },
];

// PATCH_16/21: Normalize category for vision-aligned filtering (canon mapping)
function normalizeCategory(input) {
  if (!input) return "general";
  const v = String(input).toLowerCase();
  if (v.includes("micro")) return "microjobs";
  if (v.includes("forex") || v.includes("crypto")) return "forex_crypto";
  if (v.includes("bank") || v.includes("gateway") || v.includes("wallet"))
    return "banks_gateways_wallets";
  // PATCH_21: Handle rentals category
  if (v.includes("rental") || v.includes("rent")) return "rentals";
  // Return as-is if already a valid category id
  if (
    [
      "microjobs",
      "forex_crypto",
      "banks_gateways_wallets",
      "rentals",
      "general",
    ].includes(v)
  )
    return v;
  return "general";
}

// PATCH_16: Normalize serviceType for vision-aligned filtering
function normalizeServiceType(input) {
  if (!input) return "general";
  const v = String(input).toLowerCase();
  if (v.includes("fresh")) return "fresh_profile";
  if (v.includes("already")) return "already_onboarded";
  if (v.includes("process")) return "interview_process";
  if (v.includes("passed")) return "interview_passed";
  // Return as-is if already a valid type id
  if (
    [
      "fresh_profile",
      "already_onboarded",
      "interview_process",
      "interview_passed",
      "general",
    ].includes(v)
  )
    return v;
  return "general";
}

// PATCH_17: Normalize listingType for two-path UX
function normalizeListingType(input) {
  if (!input) return "general";
  const v = String(input).toLowerCase();
  if (v.includes("fresh") || v === "fresh_account") return "fresh_account";
  if (
    v.includes("already") ||
    v.includes("onboard") ||
    v === "already_onboarded"
  )
    return "already_onboarded";
  if (["fresh_account", "already_onboarded", "general"].includes(v)) return v;
  return "general";
}

// PATCH_16: Normalize country names for consistent display
function normalizeCountry(input) {
  if (!input) return "Global";
  const v = String(input).trim();
  const lower = v.toLowerCase();
  if (lower === "in" || lower === "india") return "India";
  if (lower === "uae") return "UAE";
  if (lower === "us" || lower === "usa") return "USA";
  if (lower === "uk" || lower === "united kingdom") return "UK";
  if (lower === "global") return "Global";
  // Capitalize first letter for other countries
  return v.charAt(0).toUpperCase() + v.slice(1);
}

exports.createService = async (req, res) => {
  try {
    const {
      title,
      category,
      subcategory,
      description,
      price,
      currency,
      deliveryType,
      images,
      imageUrl,
      requirements,
      // PATCH_22: Country-based pricing fields
      countries,
      countryPricing,
      platform,
      subject,
      projectName,
      payRate,
      instantDelivery,
    } = req.body;

    if (!title || !category || !description || !price) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const slug = slugify(title);

    // PATCH_22: Build service payload with country pricing
    const servicePayload = {
      title,
      slug,
      category,
      subcategory: subcategory || "",
      description,
      price,
      currency: currency || "USD",
      deliveryType: deliveryType || "manual",
      images: images || [],
      imageUrl: imageUrl || "",
      requirements: requirements || "",
      createdBy: req.user.id,
      active: true,
      status: "active",
    };

    // PATCH_22: Add countries array (normalize country names)
    if (Array.isArray(countries) && countries.length > 0) {
      servicePayload.countries = countries.map((c) => normalizeCountry(c));
    }

    // PATCH_22: Add country-specific pricing
    if (countryPricing && typeof countryPricing === "object") {
      const pricingMap = new Map();
      for (const [country, priceVal] of Object.entries(countryPricing)) {
        const normalizedCountry = normalizeCountry(country);
        const numPrice = Number(priceVal);
        if (normalizedCountry && Number.isFinite(numPrice) && numPrice >= 0) {
          pricingMap.set(normalizedCountry, numPrice);
        }
      }
      if (pricingMap.size > 0) {
        servicePayload.countryPricing = pricingMap;
      }
    }

    // PATCH_22: Additional service fields
    if (platform) servicePayload.platform = platform;
    if (subject) servicePayload.subject = subject;
    if (projectName) servicePayload.projectName = projectName;
    if (payRate !== undefined) servicePayload.payRate = Number(payRate);
    if (typeof instantDelivery === "boolean")
      servicePayload.instantDelivery = instantDelivery;

    // PATCH_106: Pre-compute allowedActions and validate before saving
    const computedActions = getAllowedActionsForService(servicePayload);
    servicePayload.allowedActions = computedActions;

    const { valid, errors: validationErrors } =
      await validateServiceActions(servicePayload);
    if (!valid) {
      return res
        .status(400)
        .json({ message: validationErrors[0], errors: validationErrors });
    }

    const service = await Service.create(servicePayload);

    // PATCH_53 Hardening: Queue engagement event with safety checks
    try {
      const engagementService = require("../services/engagement.service");
      const categoryTags = [String(category).toLowerCase()];
      if (subcategory) categoryTags.push(String(subcategory).toLowerCase());

      const VALID_ENGAGEMENT_TAGS = [
        "microjobs",
        "forex",
        "wallets",
        "crypto",
        "rentals",
      ];
      const validTags = categoryTags.filter((tag) =>
        VALID_ENGAGEMENT_TAGS.includes(tag),
      );

      if (validTags.length > 0) {
        await engagementService.queueEvent({
          type: "service_new",
          title: `New ${category} Service Available`,
          message: String(title).substring(0, 500),
          targetTags: validTags,
          idempotencyKey: `service_${service._id}`,
        });
      } else {
        console.warn(
          `[Service] No valid engagement tags for service: ${category}`,
        );
      }
    } catch (engagementError) {
      console.warn(
        "[Service] Engagement event queuing failed:",
        engagementError,
      );
    }

    res.status(201).json(service);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
};

// PATCH_18/32: Filter-safe guided filtering that never loses track
exports.getActiveServices = async (req, res) => {
  try {
    setNoCache(res);

    // Extract query params
    const {
      category,
      subcategory, // PATCH_19
      listingType,
      country,
      platform,
      subject,
      projectName,
      minPayRate,
      search, // PATCH_19
      limit = 100,
      page = 1,
      sort = "createdAt",
    } = req.query;

    // PATCH_32: Simplified status filter - only use status: "active"
    // This ensures users can see services that admin has activated
    const statusFilter = { status: "active" };

    // We'll build conditions and combine them with $and at the end
    const conditions = [statusFilter];
    const appliedFilters = {};
    const ignoredFilters = [];

    // PATCH_20: Category filter with backwards compat
    const categoryVal = String(category || "").trim();
    if (categoryVal && categoryVal !== "all") {
      const normalizedCat = normalizeCategory(categoryVal);
      // Also match services with "general" category or missing category for microjobs
      if (normalizedCat === "microjobs") {
        conditions.push({
          $or: [
            { category: "microjobs" },
            { category: "general" },
            { category: { $exists: false } },
            { category: "" },
          ],
        });
      } else {
        conditions.push({ category: normalizedCat });
      }
      appliedFilters.category = normalizedCat;
    }

    // PATCH_20: Subcategory filter with backwards compat for listingType
    const subcategoryVal = String(subcategory || "").trim();
    if (subcategoryVal && subcategoryVal !== "all") {
      // Match either subcategory OR listingType (for legacy services)
      conditions.push({
        $or: [{ subcategory: subcategoryVal }, { listingType: subcategoryVal }],
      });
      appliedFilters.subcategory = subcategoryVal;
    }

    // ListingType filter (legacy support - only if subcategory not provided)
    const listingTypeVal = String(listingType || "").trim();
    const normalizedListingType =
      !subcategoryVal && listingTypeVal && listingTypeVal !== "all"
        ? normalizeListingType(listingTypeVal)
        : null;

    if (normalizedListingType) {
      // Also check subcategory for legacy support
      conditions.push({
        $or: [
          { listingType: normalizedListingType },
          { subcategory: normalizedListingType },
        ],
      });
      appliedFilters.listingType = normalizedListingType;
    }

    // PATCH_19: Text search
    const searchVal = String(search || "").trim();
    if (searchVal) {
      const searchRegex = new RegExp(searchVal, "i");
      conditions.push({
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { platform: searchRegex },
        ],
      });
      appliedFilters.search = searchVal;
    }

    // PATCH_21: Country filter - track selected country but DON'T filter out services
    // We'll mark unavailable services instead so frontend can show "Request Service" option
    const countryVal = String(country || "").trim();
    if (countryVal && countryVal !== "all") {
      // Don't add to conditions - we want to show all services and mark availability
      appliedFilters.country = countryVal;
    }

    // Platform filter
    const platformVal = String(platform || "").trim();
    if (platformVal && platformVal !== "all") {
      conditions.push({
        platform: { $regex: new RegExp(`^${platformVal}$`, "i") },
      });
      appliedFilters.platform = platformVal;
    }

    // PATCH_18: Context-aware filter application
    const isFreshAccount =
      subcategoryVal === "fresh_account" ||
      normalizedListingType === "fresh_account";
    const isAlreadyOnboarded =
      subcategoryVal === "already_onboarded" ||
      normalizedListingType === "already_onboarded";

    // Subject filter (only for fresh_account)
    const subjectVal = String(subject || "").trim();
    if (subjectVal && subjectVal !== "all") {
      if (isFreshAccount) {
        conditions.push({
          subject: { $regex: new RegExp(`^${subjectVal}$`, "i") },
        });
        appliedFilters.subject = subjectVal;
      } else {
        ignoredFilters.push({
          field: "subject",
          reason: "only applies to fresh_account",
        });
      }
    }

    // ProjectName filter (only for already_onboarded)
    const projectVal = String(projectName || "").trim();
    if (projectVal && projectVal !== "all") {
      if (isAlreadyOnboarded) {
        conditions.push({
          projectName: { $regex: new RegExp(`^${projectVal}$`, "i") },
        });
        appliedFilters.projectName = projectVal;
      } else {
        ignoredFilters.push({
          field: "projectName",
          reason: "only applies to already_onboarded",
        });
      }
    }

    // MinPayRate filter (only for already_onboarded)
    const minPayRateVal = parseFloat(minPayRate);
    if (Number.isFinite(minPayRateVal) && minPayRateVal > 0) {
      if (isAlreadyOnboarded) {
        conditions.push({ payRate: { $gte: minPayRateVal } });
        appliedFilters.minPayRate = minPayRateVal;
      } else {
        ignoredFilters.push({
          field: "minPayRate",
          reason: "only applies to already_onboarded",
        });
      }
    }

    // PATCH_20: Build final filter by combining all conditions with $and
    const baseFilter =
      conditions.length === 1 ? conditions[0] : { $and: conditions };

    // Pagination
    const take = Math.min(parseInt(limit) || 100, 200);
    const skip = (parseInt(page) - 1) * take;

    // Sort mapping
    let sortOption = { createdAt: -1, _id: -1 };
    if (sort === "topViewed") sortOption = { viewCount: -1, createdAt: -1 };
    if (sort === "priceLow") sortOption = { price: 1, createdAt: -1 };
    if (sort === "priceHigh") sortOption = { price: -1, createdAt: -1 };
    if (sort === "payRateHigh") sortOption = { payRate: -1, createdAt: -1 };

    // Fetch services
    const rawServices = await Service.find(baseFilter)
      .sort(sortOption)
      .skip(skip)
      .limit(take)
      .lean();

    // PATCH_20/21: Normalize service data, apply country-based pricing, and mark availability
    const selectedCountry = appliedFilters.country || null;
    const services = rawServices.map((s) => {
      // Normalize countries list
      const serviceCountries =
        Array.isArray(s.countries) && s.countries.length > 0
          ? s.countries.map(normalizeCountry)
          : ["Global"];

      // PATCH_21: Check if service is available for selected country
      let availableForCountry = true;
      if (selectedCountry) {
        // Service is available if: countries includes selectedCountry OR includes "Global"
        const hasSelectedCountry = serviceCountries.some(
          (c) => c.toLowerCase() === selectedCountry.toLowerCase(),
        );
        const hasGlobal = serviceCountries.some(
          (c) => c.toLowerCase() === "global",
        );
        availableForCountry = hasSelectedCountry || hasGlobal;
      }

      // Calculate effective price based on selected country (only if available)
      let effectivePrice = s.price;
      if (selectedCountry && availableForCountry && s.countryPricing) {
        // countryPricing is a Map, convert to object for lookup
        const pricing =
          s.countryPricing instanceof Map
            ? Object.fromEntries(s.countryPricing)
            : s.countryPricing || {};

        // Check for country-specific price (case-insensitive)
        const countryKey = Object.keys(pricing).find(
          (k) => k.toLowerCase() === selectedCountry.toLowerCase(),
        );
        if (countryKey && pricing[countryKey] != null) {
          effectivePrice = pricing[countryKey];
        }
      }

      return {
        ...s,
        category: s.category || "microjobs",
        subcategory: s.subcategory || s.listingType || "fresh_account",
        listingType: s.listingType || "general",
        countries: serviceCountries,
        platform: s.platform || "",
        subject: s.subject || "",
        projectName: s.projectName || "",
        payRate: s.payRate || 0,
        instantDelivery: s.instantDelivery || false,
        tags: Array.isArray(s.tags) ? s.tags : [],
        features: Array.isArray(s.features) ? s.features : [],
        // PATCH_20: Show effective price and original for comparison
        price: effectivePrice,
        basePrice: s.price,
        countryPricing:
          s.countryPricing instanceof Map
            ? Object.fromEntries(s.countryPricing)
            : s.countryPricing || {},
        // PATCH_38: Ensure allowedActions always present
        allowedActions:
          s.allowedActions && typeof s.allowedActions === "object"
            ? s.allowedActions
            : getAllowedActionsForService(s),
        // PATCH_21: Availability flag for selected country
        availableForCountry,
        selectedCountry: selectedCountry || null,
      };
    });

    const total = await Service.countDocuments(baseFilter);

    // PATCH_18: Build dynamic filter options using distinct queries
    // Each filter list is scoped to currently applied filters (except that field)
    const activeBaseFilter = {
      $or: [{ status: "active" }, { active: true, status: { $exists: false } }],
    };

    // Categories (always show all canonical)
    const categoriesFromDb = await Service.distinct(
      "category",
      activeBaseFilter,
    );

    // ListingTypes - scoped by category if selected
    const listingTypesFilter = { ...activeBaseFilter };
    if (appliedFilters.category)
      listingTypesFilter.category = appliedFilters.category;
    const listingTypesFromDb = await Service.distinct(
      "listingType",
      listingTypesFilter,
    );

    // Countries - scoped by category + listingType
    const countriesFilter = { ...listingTypesFilter };
    if (appliedFilters.listingType)
      countriesFilter.listingType = appliedFilters.listingType;
    const countriesRaw = await Service.distinct("countries", countriesFilter);
    const flatCountries = Array.isArray(countriesRaw)
      ? countriesRaw.flat()
      : [];
    const normalizedCountries = [
      ...new Set(flatCountries.map(normalizeCountry)),
    ].filter(Boolean);
    const sortedCountries = [
      "Global",
      ...normalizedCountries.filter((c) => c !== "Global").sort(),
    ];

    // Platforms - scoped
    const platformsRaw = await Service.distinct("platform", countriesFilter);
    const platforms = [...new Set(platformsRaw.filter(Boolean))].sort();

    // PATCH_18: Context-aware filter lists
    let subjects = [];
    let projects = [];
    let payRateMinMax = { min: 0, max: 100 };

    // Subjects only for fresh_account
    if (!normalizedListingType || normalizedListingType === "fresh_account") {
      const subjectsFilter = {
        ...countriesFilter,
        listingType: "fresh_account",
      };
      const subjectsRaw = await Service.distinct("subject", subjectsFilter);
      subjects = [...new Set(subjectsRaw.filter(Boolean))].sort();
    }

    // Projects + payRate only for already_onboarded
    if (
      !normalizedListingType ||
      normalizedListingType === "already_onboarded"
    ) {
      const onboardedFilter = {
        ...countriesFilter,
        listingType: "already_onboarded",
      };
      const projectsRaw = await Service.distinct(
        "projectName",
        onboardedFilter,
      );
      projects = [...new Set(projectsRaw.filter(Boolean))].sort();

      // PayRate range
      const payRateAgg = await Service.aggregate([
        {
          $match: {
            ...activeBaseFilter,
            listingType: "already_onboarded",
            payRate: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            min: { $min: "$payRate" },
            max: { $max: "$payRate" },
          },
        },
      ]);
      if (payRateAgg[0])
        payRateMinMax = { min: payRateAgg[0].min, max: payRateAgg[0].max };
    }

    // Build response
    const responseFilters = {
      categories: CANON_CATEGORIES,
      listingTypes: CANON_LISTING_TYPES.filter(
        (lt) => listingTypesFromDb.includes(lt.id) || lt.id === "general",
      ),
      // PATCH_19: Include subcategory mappings for frontend
      subcategoriesByCategory: {
        microjobs: [
          { id: "fresh_account", label: "Fresh Account (With Screening)" },
          { id: "already_onboarded", label: "Already Onboarded (Instant)" },
        ],
        forex_crypto: [
          {
            id: "forex_platform_creation",
            label: "Forex Trading Platform Creation Assistance",
          },
          {
            id: "crypto_platform_creation",
            label: "Crypto Platform Account Assistance",
          },
        ],
        banks_gateways_wallets: [
          { id: "banks", label: "Bank Account Assistance" },
          { id: "payment_gateways", label: "Payment Gateway Setup" },
          { id: "wallets", label: "Wallet Account Setup" },
        ],
        rentals: [{ id: "account_rental", label: "Account Rental" }],
        general: [{ id: "general", label: "General" }],
      },
      // Flat subcategories list for convenience
      subcategories: {
        microjobs: [
          "Fresh Account (With Screening)",
          "Already Onboarded (Instant)",
        ],
        forex_crypto: [
          "Forex Trading Platform Creation Assistance",
          "Crypto Platform Account Assistance",
        ],
        banks_gateways_wallets: [
          "Bank Account Assistance",
          "Payment Gateway Setup",
          "Wallet Account Setup",
        ],
        rentals: ["Account Rental"],
        general: ["General"],
      },
      countries: sortedCountries,
      platforms,
    };

    // Only include subject/project/payRate when relevant
    if (isFreshAccount || !normalizedListingType) {
      responseFilters.subjects = subjects;
    }
    if (isAlreadyOnboarded || !normalizedListingType) {
      responseFilters.projects = projects;
      responseFilters.payRateMinMax = payRateMinMax;
    }

    return res.json({
      ok: true,
      services,
      filters: responseFilters,
      meta: {
        appliedFilters,
        ignoredFilters,
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
      source: "mongodb",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Services] GET error:", err);
    return res.status(500).json({
      ok: false,
      message: "Failed to load services",
      error: err.message,
    });
  }
};

exports.getServiceById = async (req, res) => {
  try {
    setNoCache(res);
    const { id } = req.params;
    // PATCH_96: Validate ObjectId format to prevent CastError 500
    if (!id || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }
    const service = await Service.findById(id).lean();

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    // Normalize service data
    const normalizedService = {
      ...service,
      category: service.category || "microjobs",
      subcategory: service.subcategory || service.listingType || "general",
      countries:
        Array.isArray(service.countries) && service.countries.length > 0
          ? service.countries.map(normalizeCountry)
          : ["Global"],
      countryPricing:
        service.countryPricing instanceof Map
          ? Object.fromEntries(service.countryPricing)
          : service.countryPricing || {},
      // PATCH_38: Action rules
      allowedActions:
        service.allowedActions && typeof service.allowedActions === "object"
          ? service.allowedActions
          : getAllowedActionsForService(service),
      // PATCH_40: Features fallback - provide sensible defaults if empty
      features:
        Array.isArray(service.features) && service.features.length > 0
          ? service.features
          : [
              "Verified by UREMO team",
              "Secure transaction processing",
              "24-48 hour fulfillment",
              "Dashboard access included",
            ],
    };

    // Wrap in service object for consistent API
    res.json({ ok: true, service: normalizedService });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.getAllServices = async (req, res) => {
  try {
    setNoCache(res);
    const services = await Service.find().sort({ createdAt: -1 });
    res.json(services);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH_38: GET /api/services/:id/actions
exports.getServiceActions = async (req, res) => {
  try {
    const { id } = req.params;
    // PATCH_96: Validate ObjectId format
    if (!id || !/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }
    const service = await Service.findById(id)
      .select("category subcategory allowedActions")
      .lean();

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    const allowedActions =
      service.allowedActions && typeof service.allowedActions === "object"
        ? service.allowedActions
        : getAllowedActionsForService(service);

    res.json({ allowedActions, category: service.category || "general" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH_38: Workspace guard (microjobs/writing/online_gigs only)
exports.getWorkspaceServices = async (req, res) => {
  try {
    setNoCache(res);
    const raw = await Service.find({
      status: "active",
      category: { $in: ["microjobs", "writing", "online_gigs"] },
    })
      .select(
        "title slug description price currency imageUrl images category subcategory allowedActions updatedAt active status",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Ensure allowedActions is always attached
    const services = (raw || []).map((s) => ({
      ...s,
      allowedActions:
        s.allowedActions && typeof s.allowedActions === "object"
          ? s.allowedActions
          : getAllowedActionsForService(s),
    }));

    res.json({ ok: true, services });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

// PATCH_75: Deal portal guard - filter by allowedActions.deal === true
exports.getDealPortalServices = async (req, res) => {
  try {
    setNoCache(res);

    // Fetch active services
    const raw = await Service.find({ status: "active" })
      .select(
        "title slug description price currency imageUrl images category subcategory allowedActions updatedAt active status",
      )
      .sort({ createdAt: -1 })
      .lean();

    // Filter by allowedActions.deal === true (not just by category)
    const services = (raw || [])
      .map((s) => ({
        ...s,
        allowedActions:
          s.allowedActions && typeof s.allowedActions === "object"
            ? s.allowedActions
            : getAllowedActionsForService(s),
      }))
      .filter((s) => {
        // Only return services that explicitly allow deals
        return s.allowedActions?.deal === true && s.active !== false;
      });

    res.json({ ok: true, services });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.updateService = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      title,
      category,
      subcategory,
      description,
      requirements,
      price,
      currency,
      images,
      imageUrl,
      deliveryType,
      type,
      active,
      isActive,
      // PATCH_22: Country-based pricing fields
      countries,
      countryPricing,
      platform,
      subject,
      projectName,
      payRate,
      instantDelivery,
      status,
    } = req.body || {};

    const payload = {};

    if (typeof title === "string" && title.trim()) {
      payload.title = title.trim();
      payload.slug = slugify(payload.title);
    }
    if (typeof category === "string") payload.category = category;
    // PATCH_22: Subcategory support
    if (typeof subcategory === "string") payload.subcategory = subcategory;
    if (typeof description === "string") payload.description = description;
    if (typeof requirements === "string") payload.requirements = requirements;
    if (price !== undefined) payload.price = Number(price);
    if (typeof currency === "string" && currency.trim()) {
      payload.currency = currency.trim();
    }
    if (Array.isArray(images)) payload.images = images;
    if (typeof imageUrl === "string") payload.imageUrl = imageUrl;

    const resolvedDeliveryType =
      typeof deliveryType === "string"
        ? deliveryType
        : typeof type === "string"
          ? type
          : undefined;
    if (resolvedDeliveryType) payload.deliveryType = resolvedDeliveryType;

    const resolvedActive =
      typeof active === "boolean"
        ? active
        : typeof isActive === "boolean"
          ? isActive
          : undefined;
    if (resolvedActive !== undefined) payload.active = resolvedActive;

    // PATCH_22: Country-based pricing support
    if (Array.isArray(countries)) {
      payload.countries = countries.map((c) => normalizeCountry(c));
    }

    // PATCH_22: Handle countryPricing Map
    if (countryPricing && typeof countryPricing === "object") {
      // Convert to Map if it's a plain object
      const pricingMap = new Map();
      for (const [country, priceVal] of Object.entries(countryPricing)) {
        const normalizedCountry = normalizeCountry(country);
        const numPrice = Number(priceVal);
        if (normalizedCountry && Number.isFinite(numPrice) && numPrice >= 0) {
          pricingMap.set(normalizedCountry, numPrice);
        }
      }
      payload.countryPricing = pricingMap;
    }

    // PATCH_22: Additional service fields
    if (typeof platform === "string") payload.platform = platform.trim();
    if (typeof subject === "string") payload.subject = subject.trim();
    if (typeof projectName === "string")
      payload.projectName = projectName.trim();
    if (payRate !== undefined) payload.payRate = Number(payRate);
    if (typeof instantDelivery === "boolean")
      payload.instantDelivery = instantDelivery;
    if (
      typeof status === "string" &&
      ["draft", "active", "archived"].includes(status)
    ) {
      payload.status = status;
    }

    // PATCH_106: Auto-cleanup inconsistencies before saving
    // Fetch existing service to merge with payload for validation
    const existingService = await Service.findById(id).lean();
    if (!existingService) {
      return res.status(404).json({ message: "Service not found" });
    }

    const merged = { ...existingService, ...payload };
    const computedActions = getAllowedActionsForService(merged);
    merged.allowedActions = computedActions;

    // PATCH_106: Rule 5 — auto-cleanup before validation
    autoCleanupInconsistencies(merged);

    const { valid, errors: validationErrors } = await validateServiceActions(
      merged,
      {
        isUpdate: true,
        existingService,
      },
    );
    if (!valid) {
      return res
        .status(400)
        .json({ message: validationErrors[0], errors: validationErrors });
    }

    const service = await Service.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json(service);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findByIdAndDelete(id);

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json({ message: "Service deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH_59: Unified Intent-Based Marketplace API
// GET /api/services/marketplace?intent=buy|earn|rent|deal&category=...&search=...
exports.getMarketplace = async (req, res) => {
  try {
    setNoCache(res);

    const {
      intent = "all", // buy, earn, rent, deal, all
      category,
      subcategory,
      country,
      search,
      minPrice,
      maxPrice,
      sort = "relevance",
      limit = 50,
      page = 1,
    } = req.query;

    // Build base query
    const query = { status: "active", active: true };

    // Category filtering (apply at DB level)
    if (category && category !== "all") {
      const effectiveCategories = [];
      const cat = normalizeCategory(category);
      effectiveCategories.push(cat);
      // Include legacy category mappings
      if (cat === "banks_wallets") {
        effectiveCategories.push("banks_gateways_wallets");
      }
      if (cat === "crypto_accounts") {
        effectiveCategories.push("forex_crypto");
      }
      query.category = { $in: effectiveCategories };
    }

    // Subcategory filtering
    if (subcategory && subcategory !== "all") {
      query.subcategory = subcategory;
    }

    // Country filtering
    if (country && country !== "all" && country !== "Global") {
      query.$or = [
        { countries: { $in: [country, "Global"] } },
        { countries: { $size: 0 } },
        { countries: { $exists: false } },
      ];
    }

    // Search filtering
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      query.$and = (query.$and || []).concat([
        {
          $or: [
            { title: searchRegex },
            { description: searchRegex },
            { shortDescription: searchRegex },
            { searchKeywords: searchRegex },
            { platform: searchRegex },
            { subject: searchRegex },
            { tags: { $in: [searchRegex] } },
          ],
        },
      ]);
    }

    // Price filtering
    if (minPrice) query.price = { ...query.price, $gte: Number(minPrice) };
    if (maxPrice) query.price = { ...query.price, $lte: Number(maxPrice) };

    // Sorting
    let sortBy = { createdAt: -1 };
    if (sort === "price_low") sortBy = { price: 1 };
    if (sort === "price_high") sortBy = { price: -1 };
    if (sort === "newest") sortBy = { createdAt: -1 };
    if (sort === "popular") sortBy = { purchaseCount: -1, viewCount: -1 };
    if (sort === "relevance" && intent !== "all") {
      sortBy = { [`intentPriority.${intent}`]: -1, createdAt: -1 };
    }

    // PATCH_62: Fetch all matching services and filter by intent in-memory
    // This handles legacy services without stored allowedActions
    const rawServices = await Service.find(query)
      .sort(sortBy)
      .populate("linkedJobId", "title hasScreening")
      .lean();

    // Enrich with computed allowedActions and filter by intent
    const enrichedServices = rawServices.map((s) => ({
      ...s,
      allowedActions:
        s.allowedActions &&
        typeof s.allowedActions === "object" &&
        s.allowedActions.buy !== undefined
          ? s.allowedActions
          : getAllowedActionsForService(s),
      effectiveCategory: getEffectiveCategoryFromService(s),
      linkedJob: s.linkedJobId || null,
    }));

    // Filter by intent (in-memory to handle legacy data)
    const intentActionMap = {
      buy: "buy",
      earn: "apply",
      rent: "rent",
      deal: "deal",
    };

    let filteredServices = enrichedServices;
    if (intent && intent !== "all" && intentActionMap[intent]) {
      const actionKey = intentActionMap[intent];
      filteredServices = enrichedServices.filter(
        (s) => s.allowedActions?.[actionKey] === true,
      );
    }

    // Pagination (apply after filtering)
    const total = filteredServices.length;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Math.min(Number(limit), 100);
    const paginatedServices = filteredServices.slice(skip, skip + take);

    // Build dynamic filters from results (aggregated)
    const filtersAggregation = await Service.aggregate([
      { $match: { status: "active", active: true } },
      {
        $group: {
          _id: null,
          categories: { $addToSet: "$category" },
          subcategories: { $addToSet: "$subcategory" },
          countries: { $push: "$countries" },
          platforms: { $addToSet: "$platform" },
          priceMin: { $min: "$price" },
          priceMax: { $max: "$price" },
        },
      },
    ]);

    const filterOptions = filtersAggregation[0] || {
      categories: [],
      subcategories: [],
      countries: [],
      platforms: [],
      priceMin: 0,
      priceMax: 1000,
    };

    // Flatten countries array
    const allCountries = [
      ...new Set((filterOptions.countries || []).flat().filter(Boolean)),
    ];

    // PATCH_62: Intent counts from enriched services (already computed allowedActions)
    // Use enrichedServices (pre-filter) to get accurate counts for all intents
    const intentCounts = { buy: 0, earn: 0, rent: 0, deal: 0 };
    for (const s of enrichedServices) {
      if (s.allowedActions?.buy) intentCounts.buy++;
      if (s.allowedActions?.apply) intentCounts.earn++;
      if (s.allowedActions?.rent) intentCounts.rent++;
      if (s.allowedActions?.deal) intentCounts.deal++;
    }

    res.json({
      ok: true,
      services: paginatedServices,
      meta: {
        total,
        page: Number(page),
        limit: take,
        pages: Math.ceil(total / take),
        intent,
      },
      filters: {
        categories: (filterOptions.categories || [])
          .filter(Boolean)
          .map((c) => ({
            id: c,
            label:
              CANON_CATEGORIES.find((cc) => cc.id === c)?.label ||
              c.replace(/_/g, " "),
          })),
        subcategories: (filterOptions.subcategories || []).filter(Boolean),
        countries: allCountries,
        platforms: (filterOptions.platforms || []).filter(Boolean),
        priceRange: {
          min: filterOptions.priceMin || 0,
          max: filterOptions.priceMax || 1000,
        },
      },
      intentCounts: {
        buy: intentCounts.buy,
        earn: intentCounts.earn,
        rent: intentCounts.rent,
        deal: intentCounts.deal,
      },
    });
  } catch (err) {
    console.error("[MARKETPLACE_ERROR]", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
};

// PATCH_59: Get filters dynamically from Service collection
exports.getMarketplaceFilters = async (req, res) => {
  try {
    setNoCache(res);

    const aggregation = await Service.aggregate([
      { $match: { status: "active", active: true } },
      {
        $group: {
          _id: null,
          categories: { $addToSet: "$category" },
          subcategories: { $addToSet: "$subcategory" },
          countries: { $push: "$countries" },
          platforms: { $addToSet: "$platform" },
          subjects: { $addToSet: "$subject" },
          projectNames: { $addToSet: "$projectName" },
          priceMin: { $min: "$price" },
          priceMax: { $max: "$price" },
          payRateMin: { $min: "$payRate" },
          payRateMax: { $max: "$payRate" },
        },
      },
    ]);

    const data = aggregation[0] || {};
    const allCountries = [
      ...new Set((data.countries || []).flat().filter(Boolean)),
    ];

    // Category-subcategory mapping from schema
    const categorySubcategoryMap = SUBCATEGORY_BY_CATEGORY;

    res.json({
      ok: true,
      filters: {
        categories: (data.categories || []).filter(Boolean).map((c) => ({
          id: c,
          label:
            CANON_CATEGORIES.find((cc) => cc.id === c)?.label ||
            c.replace(/_/g, " "),
          subcategories: categorySubcategoryMap[c] || [],
        })),
        countries: allCountries,
        platforms: (data.platforms || []).filter(Boolean),
        subjects: (data.subjects || []).filter(Boolean),
        projectNames: (data.projectNames || []).filter(Boolean),
        priceRange: { min: data.priceMin || 0, max: data.priceMax || 1000 },
        payRateRange: {
          min: data.payRateMin || 0,
          max: data.payRateMax || 100,
        },
      },
      categorySubcategoryMap,
    });
  } catch (err) {
    console.error("[FILTERS_ERROR]", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
};

// ============================================================
// PATCH_107: Repair Legacy Service Data (admin-only endpoint)
// ============================================================
exports.repairLegacyServices = async (req, res) => {
  try {
    const allServices = await Service.find({});
    const stats = {
      totalServices: allServices.length,
      repairedBuy: 0,
      repairedRent: 0,
      repairedApply: 0,
      repairedDeal: 0,
      totalModified: 0,
    };
    const repairLog = { buy: [], rent: [], apply: [], deal: [] };

    for (const service of allServices) {
      let modified = false;
      const id = service._id.toString();
      const title = service.title || "(untitled)";

      if (!service.allowedActions) {
        service.allowedActions = {
          buy: false,
          apply: false,
          rent: false,
          deal: false,
        };
        modified = true;
      }

      // buy=true & price≤0 → set buy=false
      if (
        service.allowedActions.buy === true &&
        (!service.price || service.price <= 0)
      ) {
        service.allowedActions.buy = false;
        stats.repairedBuy++;
        repairLog.buy.push({ id, title, price: service.price });
        modified = true;
      }

      // rent=true & (isRental!==true OR rentalPlans empty) → set rent=false, isRental=false
      if (service.allowedActions.rent === true) {
        const hasValidRental =
          service.isRental === true &&
          Array.isArray(service.rentalPlans) &&
          service.rentalPlans.length > 0;
        if (!hasValidRental) {
          service.allowedActions.rent = false;
          service.isRental = false;
          stats.repairedRent++;
          repairLog.rent.push({
            id,
            title,
            rentalPlansCount: (service.rentalPlans || []).length,
          });
          modified = true;
        }
      }

      // apply=true & linkedJobId==null → set apply=false
      if (service.allowedActions.apply === true && !service.linkedJobId) {
        service.allowedActions.apply = false;
        stats.repairedApply++;
        repairLog.apply.push({ id, title });
        modified = true;
      }

      // deal=true & price≤0 → set deal=false
      if (
        service.allowedActions.deal === true &&
        (!service.price || service.price <= 0)
      ) {
        service.allowedActions.deal = false;
        stats.repairedDeal++;
        repairLog.deal.push({ id, title, price: service.price });
        modified = true;
      }

      if (modified) {
        await service.save({ validateBeforeSave: false });
        stats.totalModified++;
      }
    }

    console.log("[PATCH_107] Repair complete:", JSON.stringify(stats));
    res.json({ ok: true, stats, repairLog });
  } catch (err) {
    console.error("[REPAIR_ERROR]", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
};
