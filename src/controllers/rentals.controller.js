/**
 * PATCH_22: Rentals Controller
 * Handles rental/subscription creation, listing, and management
 */

const Rental = require("../models/Rental");
const Service = require("../models/Service");
const Order = require("../models/Order");
const { canReadRentalAccess } = require("../utils/rentalAccess");
const { sendNotification } = require("../services/notification.service");

// PATCH_38: Action rules enforcement
const { getAllowedActionsForService } = require("../config/categoryActions");

// PATCH_31: FlowEngine for orchestrated state transitions
const FlowEngine = require("../core/flowEngine");

// Helper to calculate end date
const calculateEndDate = (startDate, duration, unit) => {
  const start = new Date(startDate);
  if (unit === "months") {
    start.setMonth(start.getMonth() + duration);
  } else {
    // days
    start.setDate(start.getDate() + duration);
  }
  return start;
};

function customerRental(rental, userId, now) {
  const { notes, accessDetails, ...details } = rental;
  details.isActive = canReadRentalAccess(rental, rental.order, userId, now);
  if (details.isActive) details.accessDetails = accessDetails;
  return details;
}

/**
 * GET ALL RENTAL SERVICES (PUBLIC)
 * GET /api/rentals
 * Returns all services marked as isRental=true with their rental plans
 */
exports.getRentalServices = async (req, res) => {
  try {
    // Find all active services that are marked as rentals
    const rentalServices = await Service.find({
      isRental: true,
      $or: [{ status: "active" }, { active: true }],
    })
      .select(
        "title slug description price imageUrl images countries rentalPlans rentalDescription maxActiveRentals currentActiveRentals category",
      )
      .lean();

    // Format response
    const rentals = rentalServices.map((s) => ({
      _id: s._id,
      title: s.title,
      slug: s.slug,
      description: s.rentalDescription || s.description,
      price: s.price,
      imageUrl: s.imageUrl || (s.images && s.images[0]) || "",
      countries: s.countries || ["Global"],
      plans: s.rentalPlans || [],
      maxSlots: s.maxActiveRentals || 0,
      availableSlots: Math.max(
        0,
        (s.maxActiveRentals || 0) - (s.currentActiveRentals || 0),
      ),
      category: s.category || "rentals",
    }));

    res.json({ ok: true, rentals });
  } catch (err) {
    console.error("[RENTALS_LIST_ERROR]", err.message);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch rental services" });
  }
};

/**
 * CREATE RENTAL ORDER
 * POST /api/rentals/create
 * Body: { serviceId, planIndex }
 */
exports.createRentalOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res
        .status(401)
        .json({ ok: false, message: "Authentication required" });
    }

    const { serviceId, planIndex, country } = req.body;

    if (!serviceId) {
      return res
        .status(400)
        .json({ ok: false, message: "serviceId is required" });
    }

    if (planIndex === undefined || planIndex === null) {
      return res
        .status(400)
        .json({ ok: false, message: "planIndex is required" });
    }

    // PATCH_111: Validate planIndex is a non-negative integer to prevent prototype pollution
    const idx = parseInt(planIndex, 10);
    if (isNaN(idx) || idx < 0 || String(idx) !== String(planIndex)) {
      return res
        .status(400)
        .json({ ok: false, message: "planIndex must be a valid non-negative integer" });
    }

    // Fetch the service
    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ ok: false, message: "Service not found" });
    }

    const allowed =
      service.allowedActions && typeof service.allowedActions === "object"
        ? service.allowedActions
        : getAllowedActionsForService(service);
    if (!allowed.rent) {
      return res.status(403).json({
        ok: false,
        error: "RENT_NOT_ALLOWED",
        message: "Rentals are not available for this service",
      });
    }

    if (!service.isRental) {
      return res.status(400).json({
        ok: false,
        message: "This service is not available for rental",
      });
    }

    if (!service.rentalPlans || !service.rentalPlans[idx]) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid rental plan selected" });
    }

    const plan = service.rentalPlans[idx];

    // Check max active rentals limit
    if (
      service.maxActiveRentals > 0 &&
      service.currentActiveRentals >= service.maxActiveRentals
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "This rental service is currently at capacity. Please try again later.",
      });
    }

    // Check if user already has an active rental for this service
    const existingActive = await Rental.findOne({
      user: userId,
      service: serviceId,
      status: "active",
    });

    if (existingActive) {
      return res.status(400).json({
        ok: false,
        message: "You already have an active rental for this service",
        existingRental: {
          id: existingActive._id,
          endDate: existingActive.endDate,
        },
      });
    }

    const startDate = new Date();
    const endDate = calculateEndDate(startDate, plan.duration, plan.unit);

    // Create the order first (PATCH_37: normalized status)
    const order = await Order.create({
      userId,
      serviceId,
      status: "pending",
      orderType: "rental",
      quotedAmount: plan.price,
      quotedCurrency: service.currency || "USD",
      country: country || null,
      notes: `Rental: ${plan.duration} ${plan.unit} - ${service.title}`,
      statusLog: [{ text: "Rental order created", at: new Date() }],
    });

    // Create the rental record
    const rental = await Rental.create({
      user: userId,
      service: serviceId,
      order: order._id,
      rentalType: plan.unit,
      duration: plan.duration,
      price: plan.price,
      currency: service.currency || "USD",
      startDate,
      endDate,
      status: "pending", // Will become "active" after payment
      statusLog: [
        {
          status: "pending",
          at: new Date(),
          by: "system",
          note: "Rental created",
        },
      ],
    });

    // PATCH_92: Store rentalId back on order for cross-reference
    order.rentalId = rental._id;
    await order.save();

    res.status(201).json({
      ok: true,
      message: "Rental order created successfully",
      rental: {
        _id: rental._id,
        service: {
          _id: service._id,
          title: service.title,
        },
        plan: {
          duration: plan.duration,
          unit: plan.unit,
          price: plan.price,
        },
        price: plan.price,
        duration: plan.duration,
        rentalType: plan.unit,
        startDate: rental.startDate,
        endDate: rental.endDate,
        status: rental.status,
      },
      order: {
        _id: order._id,
        status: order.status,
        orderType: order.orderType,
      },
    });
  } catch (err) {
    console.error("[RENTAL_CREATE_ERROR]", err.message);
    res
      .status(500)
      .json({ ok: false, message: "Failed to create rental order" });
  }
};

/**
 * GET USER RENTALS
 * GET /api/rentals/my
 * Query: status (optional) - filter by status
 */
exports.getUserRentals = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res
        .status(401)
        .json({ ok: false, message: "Authentication required" });
    }

    const { status } = req.query;

    const query = { user: userId };
    if (
      status &&
      ["pending", "active", "expired", "cancelled", "renewed"].includes(status)
    ) {
      query.status = status;
    }

    const rentals = await Rental.find(query)
      .populate("service", "title slug imageUrl category subcategory")
      .populate({ path: "order", match: { userId }, select: "status payment paymentStatus paidAt userId rentalId" })
      .sort({ createdAt: -1 })
      .lean();

    // Add computed fields
    const enrichedRentals = rentals.map((r) => {
      const now = new Date();
      const end = new Date(r.endDate);
      const diffMs = end - now;
      const daysRemaining = Math.max(
        0,
        Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
      );

      // PATCH_109: Frontend-computed expiry override
      const computedStatus =
        r.status === "active" && now > end ? "expired" : r.status;

      return {
        ...customerRental(r, userId, now),
        daysRemaining,
        isExpiringSoon: r.status === "active" && daysRemaining <= 3,
        computedStatus,
        activatedAt: r.activatedAt || null,
      };
    });

    res.set("Cache-Control", "private, no-store").json({
      ok: true,
      rentals: enrichedRentals,
      counts: {
        total: enrichedRentals.length,
        active: enrichedRentals.filter((r) => r.status === "active").length,
        expired: enrichedRentals.filter((r) => r.status === "expired").length,
        pending: enrichedRentals.filter((r) => r.status === "pending").length,
      },
    });
  } catch (err) {
    console.error("[GET_USER_RENTALS_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to fetch rentals" });
  }
};

/**
 * GET SINGLE RENTAL
 * GET /api/rentals/:id
 */
exports.getRentalById = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    const rental = await Rental.findOne({ _id: id, user: userId })
      .populate(
        "service",
        "title slug imageUrl category subcategory rentalDescription",
      )
      .populate({ path: "order", match: { userId }, select: "status payment paymentStatus paidAt userId rentalId" })
      .lean();

    if (!rental) {
      return res.status(404).json({ ok: false, message: "Rental not found" });
    }

    const now = new Date();
    const end = new Date(rental.endDate);
    const diffMs = end - now;
    const daysRemaining = Math.max(
      0,
      Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
    );

    res.set("Cache-Control", "private, no-store").json({
      ok: true,
      rental: {
        ...customerRental(rental, userId, now),
        daysRemaining,
        isExpiringSoon: rental.status === "active" && daysRemaining <= 3,
      },
    });
  } catch (err) {
    console.error("[GET_RENTAL_BY_ID_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to fetch rental" });
  }
};

/**
 * ACTIVATE RENTAL (called after payment verification)
 * PUT /api/rentals/:id/activate
 * Admin only
 */
exports.activateRental = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // PATCH_31: Use FlowEngine for status transition
    const canTransitionResult = await FlowEngine.canTransition(
      "rental",
      id,
      "active",
    );

    if (!canTransitionResult.allowed) {
      return res.status(400).json({
        ok: false,
        message:
          canTransitionResult.reason ||
          `Cannot activate rental with status: ${canTransitionResult.currentState}`,
      });
    }

    // Get rental to update dates
    const rental = await Rental.findById(id);
    if (!rental) {
      return res.status(404).json({ ok: false, message: "Rental not found" });
    }

    // Reset dates from now
    const startDate = new Date();
    const endDate = calculateEndDate(
      startDate,
      rental.duration,
      rental.rentalType,
    );

    // Update dates first
    rental.startDate = startDate;
    rental.endDate = endDate;
    await rental.save();

    // PATCH_31: Use FlowEngine for status transition
    // FlowEngine handles: status update, timeline, notification (via hooks)
    const activatedRental = await FlowEngine.transition(
      "rental",
      id,
      "active",
      {
        actor: "admin",
        adminId: req.user?._id || req.user?.id,
        reason: reason || "Payment verified, rental activated",
        data: { startDate, endDate },
      },
    );

    // Attach service name for notification
    activatedRental.serviceName = rental.serviceName;

    // Update service's active rental count
    await Service.findByIdAndUpdate(rental.service, {
      $inc: { currentActiveRentals: 1 },
    });

    // PATCH_108: Fetch full rental document for complete response
    const fullRental = await Rental.findById(id).lean();

    res.json({
      ok: true,
      message: "Rental activated successfully",
      rental: {
        _id: activatedRental._id,
        status: activatedRental.status,
        startDate: activatedRental.startDate,
        endDate: activatedRental.endDate,
        activatedAt: fullRental?.activatedAt || startDate,
        statusLog: fullRental?.statusLog || [],
        timeline: fullRental?.timeline || [],
      },
    });
  } catch (err) {
    console.error("[ACTIVATE_RENTAL_ERROR]", err.message);
    if (err.message?.includes("Invalid transition")) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    res.status(500).json({ ok: false, message: "Failed to activate rental" });
  }
};

/**
 * CANCEL RENTAL
 * PUT /api/rentals/:id/cancel
 */
exports.cancelRental = async (req, res) => {
  try {
    const userId = req.user?.id;
    const isAdmin = req.user?.role === "admin";
    const { id } = req.params;
    const { reason } = req.body;

    // PATCH_31: Use FlowEngine for status transition
    const canTransitionResult = await FlowEngine.canTransition(
      "rental",
      id,
      "cancelled",
    );

    if (!canTransitionResult.allowed) {
      return res.status(400).json({
        ok: false,
        message:
          canTransitionResult.reason ||
          `Rental is already ${canTransitionResult.currentState}`,
      });
    }

    const rental = await Rental.findById(id);
    if (!rental) {
      return res.status(404).json({ ok: false, message: "Rental not found" });
    }

    // Only owner or admin can cancel
    if (!isAdmin && rental.user.toString() !== userId) {
      return res.status(403).json({ ok: false, message: "Not authorized" });
    }

    const wasActive = rental.status === "active";

    // PATCH_31: Use FlowEngine for status transition
    const cancelledRental = await FlowEngine.transition(
      "rental",
      id,
      "cancelled",
      {
        actor: isAdmin ? "admin" : "user",
        adminId: isAdmin ? req.user?._id : undefined,
        reason: reason || "Cancelled by request",
      },
    );

    // Decrement active rental count if was active
    if (wasActive) {
      await Service.findByIdAndUpdate(rental.service, {
        $inc: { currentActiveRentals: -1 },
      });
    }

    res.json({
      ok: true,
      message: "Rental cancelled successfully",
      rental: {
        _id: cancelledRental._id,
        status: cancelledRental.status,
      },
    });
  } catch (err) {
    console.error("[CANCEL_RENTAL_ERROR]", err.message);
    if (err.message?.includes("Invalid transition")) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    res.status(500).json({ ok: false, message: "Failed to cancel rental" });
  }
};

/**
 * ADMIN: GET ALL RENTALS
 * GET /api/admin/rentals
 */
exports.getAdminRentals = async (req, res) => {
  try {
    const { status, serviceId, page = 1, limit = 50 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (serviceId) query.service = serviceId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [rentals, total] = await Promise.all([
      Rental.find(query)
        .populate("user", "email name")
        .populate("service", "title slug")
        .populate("order", "status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Rental.countDocuments(query),
    ]);

    res.json({
      ok: true,
      rentals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("[ADMIN_GET_RENTALS_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to fetch rentals" });
  }
};

/**
 * ADMIN: UPDATE RENTAL ACCESS DETAILS
 * PUT /api/admin/rentals/:id/access
 */
exports.updateRentalAccess = async (req, res) => {
  try {
    const { id } = req.params;
    const { accessDetails, notes } = req.body;

    const rental = await Rental.findById(id);
    if (!rental) {
      return res.status(404).json({ ok: false, message: "Rental not found" });
    }

    if (accessDetails !== undefined) rental.accessDetails = accessDetails;
    if (notes !== undefined) rental.notes = notes;

    await rental.save();

    res.json({
      ok: true,
      message: "Rental updated successfully",
      rental: {
        _id: rental._id,
        accessDetails: rental.accessDetails,
        notes: rental.notes,
      },
    });
  } catch (err) {
    console.error("[UPDATE_RENTAL_ACCESS_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to update rental" });
  }
};

/**
 * PATCH_109: ADMIN RENTAL REVENUE INTELLIGENCE
 * GET /api/admin/rentals/metrics
 * Returns aggregated rental metrics using efficient pipelines
 */
exports.getRentalMetrics = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Run all aggregations in parallel for speed
    const [
      statusCounts,
      expiringIn7Days,
      recentExpired,
      recentRevenue,
      lifetimeRevenue,
      mostRented,
    ] = await Promise.all([
      // 1. Count by status
      Rental.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),

      // 2. Expiring in 7 days (active + endDate within 7 days)
      Rental.countDocuments({
        status: "active",
        endDate: { $gte: now, $lte: sevenDaysFromNow },
      }),

      // 3. Expired in last 30 days
      Rental.countDocuments({
        status: "expired",
        expiredAt: { $gte: thirtyDaysAgo },
      }).then((count) => {
        // Also count active ones that are logically expired
        if (count === 0) {
          return Rental.countDocuments({
            status: "expired",
            endDate: { $gte: thirtyDaysAgo },
          });
        }
        return count;
      }),

      // 4. Revenue last 30 days (from activated rentals)
      Rental.aggregate([
        {
          $match: {
            status: { $in: ["active", "expired", "renewed"] },
            activatedAt: { $gte: thirtyDaysAgo },
          },
        },
        { $group: { _id: null, total: { $sum: "$price" } } },
      ]),

      // 5. Lifetime revenue (all non-pending/cancelled)
      Rental.aggregate([
        {
          $match: {
            status: { $in: ["active", "expired", "renewed"] },
          },
        },
        { $group: { _id: null, total: { $sum: "$price" } } },
      ]),

      // 6. Most rented service (top by count)
      Rental.aggregate([
        {
          $match: {
            status: { $in: ["active", "expired", "renewed"] },
          },
        },
        { $group: { _id: "$service", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
        {
          $lookup: {
            from: "services",
            localField: "_id",
            foreignField: "_id",
            as: "serviceDoc",
          },
        },
        { $unwind: { path: "$serviceDoc", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceId: "$_id",
            title: "$serviceDoc.title",
            count: 1,
          },
        },
      ]),
    ]);

    // Parse status counts
    const countsByStatus = {};
    statusCounts.forEach((s) => {
      countsByStatus[s._id] = s.count;
    });

    const topService = mostRented[0] || null;

    res.json({
      ok: true,
      metrics: {
        activeRentals: countsByStatus["active"] || 0,
        pendingRentals: countsByStatus["pending"] || 0,
        expiringIn7Days,
        expiredLast30Days: recentExpired,
        revenueLast30Days: recentRevenue[0]?.total || 0,
        lifetimeRevenue: lifetimeRevenue[0]?.total || 0,
        mostRentedService: topService
          ? {
              serviceId: topService.serviceId,
              title: topService.title || "Unknown",
              rentalCount: topService.count,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("[RENTAL_METRICS_ERROR]", err.message);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch rental metrics" });
  }
};

/**
 * CRON JOB: EXPIRE RENTALS
 * Called periodically to mark expired rentals
 * GET /api/cron/expire-rentals
 * PATCH_109: Enhanced with timeline entries + notifications
 * PATCH_111: Added CRON_SECRET authentication
 */
exports.expireRentalsJob = async (req, res) => {
  try {
    // PATCH_111: Require CRON_SECRET — prevent unauthorized public access
    const secret = String(req.query?.secret || "");
    const expected =
      process.env.CRON_SECRET || process.env.CRON_EXPIRE_RENTALS_SECRET || "";
    if (!expected) {
      return res.status(404).json({ message: "Route not found" });
    }
    if (!secret || secret !== expected) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const now = new Date();

    // Find all active rentals that have passed their end date
    const expiredRentals = await Rental.find({
      status: "active",
      endDate: { $lt: now },
    }).populate("service", "title");

    if (expiredRentals.length === 0) {
      return res.json({
        ok: true,
        message: "No rentals to expire",
        expiredCount: 0,
      });
    }

    // Update each rental
    const serviceDecrements = {};
    for (const rental of expiredRentals) {
      rental.status = "expired";
      rental.expiredAt = now;
      rental.statusLog.push({
        status: "expired",
        at: now,
        by: "system",
        note: "Rental period ended",
      });
      // PATCH_109: Push to timeline
      rental.timeline.push({
        event: "expired",
        from: "active",
        at: now,
        actor: "system",
        reason: "Rental period ended — auto-expired by system",
        meta: { endDate: rental.endDate },
      });
      await rental.save();

      // Track service decrements
      const sid = rental.service?._id?.toString() || rental.service?.toString();
      serviceDecrements[sid] = (serviceDecrements[sid] || 0) + 1;

      // PATCH_109: Send notification to user
      try {
        const serviceTitle = rental.service?.title || "a service";
        await sendNotification({
          userId: rental.user.toString(),
          title: "Rental Access Expired",
          message: `Your rental access for "${serviceTitle}" has expired. Renew to continue access.`,
          type: "rental",
          resourceType: "rental",
          resourceId: rental._id,
          sendEmailCopy: true,
        });
      } catch (notifErr) {
        console.error("[EXPIRE_RENTALS_NOTIF_ERROR]", notifErr.message);
      }
    }

    // Decrement active rental counts — use direct update to avoid hook corruption
    for (const [serviceId, count] of Object.entries(serviceDecrements)) {
      await Service.findByIdAndUpdate(serviceId, {
        $inc: { currentActiveRentals: -count },
      });
    }

    console.log(
      `[CRON_EXPIRE_RENTALS] Expired ${expiredRentals.length} rentals`,
    );

    res.json({
      ok: true,
      message: `Expired ${expiredRentals.length} rentals`,
      expiredCount: expiredRentals.length,
      expiredIds: expiredRentals.map((r) => r._id),
    });
  } catch (err) {
    console.error("[EXPIRE_RENTALS_JOB_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to run expiry job" });
  }
};

/**
 * RENEW RENTAL
 * POST /api/rentals/:id/renew
 * Body: { planIndex }
 */
exports.renewRental = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { planIndex } = req.body;

    const existingRental = await Rental.findOne({ _id: id, user: userId });
    if (!existingRental) {
      return res.status(404).json({ ok: false, message: "Rental not found" });
    }

    if (!["active", "expired"].includes(existingRental.status)) {
      return res.status(400).json({
        ok: false,
        message: "Only active or expired rentals can be renewed",
      });
    }

    const service = await Service.findById(existingRental.service);
    if (!service || !service.isRental) {
      return res
        .status(400)
        .json({ ok: false, message: "Service not available for renewal" });
    }

    if (planIndex === undefined || planIndex === null) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid rental plan" });
    }

    // PATCH_111: Validate planIndex is a non-negative integer
    const ridx = parseInt(planIndex, 10);
    if (isNaN(ridx) || ridx < 0 || String(ridx) !== String(planIndex)) {
      return res
        .status(400)
        .json({ ok: false, message: "planIndex must be a valid non-negative integer" });
    }

    if (!service.rentalPlans[ridx]) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid rental plan" });
    }

    const plan = service.rentalPlans[ridx];

    // Calculate new dates
    const startDate =
      existingRental.status === "active"
        ? new Date(existingRental.endDate) // Start after current period
        : new Date(); // Start now if expired
    const endDate = calculateEndDate(startDate, plan.duration, plan.unit);

    // Create new order (PATCH_37: normalized status)
    const order = await Order.create({
      userId,
      serviceId: service._id,
      status: "pending",
      notes: `Rental Renewal: ${plan.duration} ${plan.unit} - ${service.title}`,
      orderType: "rental",
      quotedAmount: plan.price,
      quotedCurrency: service.currency || "USD",
      statusLog: [{ text: "Rental renewal order created", at: new Date() }],
    });

    // Create new rental
    const newRental = await Rental.create({
      user: userId,
      service: service._id,
      order: order._id,
      rentalType: plan.unit,
      duration: plan.duration,
      price: plan.price,
      currency: service.currency || "USD",
      startDate,
      endDate,
      status: "pending",
      renewalCount: existingRental.renewalCount + 1,
      previousRental: existingRental._id,
      statusLog: [
        {
          status: "pending",
          at: new Date(),
          by: "system",
          note: "Renewal created",
        },
      ],
    });

    order.rentalId = newRental._id;
    await order.save();

    // Mark old rental as renewed
    existingRental.status = "renewed";
    existingRental.statusLog.push({
      status: "renewed",
      at: new Date(),
      by: "user",
      note: `Renewed to rental ${newRental._id}`,
    });
    await existingRental.save();

    res.status(201).json({
      ok: true,
      message: "Rental renewal created",
      rental: {
        _id: newRental._id,
        startDate: newRental.startDate,
        endDate: newRental.endDate,
        status: newRental.status,
      },
      order: {
        _id: order._id,
        status: order.status,
      },
    });
  } catch (err) {
    console.error("[RENEW_RENTAL_ERROR]", err.message);
    res.status(500).json({ ok: false, message: "Failed to renew rental" });
  }
};
