/**
 * PATCH_31: Platform Flow Hooks
 *
 * Side-effect module that registers event handlers for state transitions.
 * These hooks trigger notifications, affiliate processing, and other
 * downstream actions when entities change state.
 *
 * This module is loaded for its side effects - it registers listeners
 * on the FlowEngine event emitter.
 */

const { on, emitter } = require("./flowEngine");

// Services (lazy-loaded)
let sendNotification, processAffiliateCommission, sendEmail;

const loadServices = () => {
  if (!sendNotification) {
    const notifService = require("../services/notification.service");
    sendNotification = notifService.sendNotification;
  }
  if (!processAffiliateCommission) {
    const affService = require("../services/affiliateCommission.service");
    processAffiliateCommission = affService.processAffiliateCommission;
  }
  if (!sendEmail) {
    const emailService = require("../services/email.service");
    sendEmail = emailService.sendEmail;
  }
};

// ==============================================
// ORDER HOOKS
// ==============================================

/**
 * Order payment verified → processing
 * - Process affiliate commission
 * - Send notification to user
 /**
 * PATCH_37: Order in_progress (renamed from processing)
 * - Process affiliate commission
 * - Send processing notification
 */
on("order.in_progress", async ({ item, previousState, meta }) => {
  loadServices();

  try {
    // Only process affiliate commission when transitioning from waiting_user (payment verified)
    if (["waiting_user", "pending"].includes(previousState)) {
      // Process affiliate commission
      await processAffiliateCommission(
        item._id,
        meta.paymentMethod || "manual",
      );
      console.log(
        `[FlowHooks] Affiliate commission processed for order ${item._id}`,
      );
    }

    // PATCH_48: Auto-activate rental when rental order is paid
    if (item.orderType === "rental" || item.serviceType === "rental") {
      try {
        const Rental = require("../models/Rental");
        const { transition } = require("./flowEngine");

        // Find the rental linked to this order
        const rental = await Rental.findOne({ order: item._id });
        if (rental && rental.status === "pending") {
          // Set start and end dates based on rental duration
          const now = new Date();
          const startDate = rental.previousRental && rental.startDate > now ? rental.startDate : now;
          const endDate = new Date(startDate);

          if (rental.rentalType === "months") {
            endDate.setMonth(endDate.getMonth() + rental.duration);
          } else {
            endDate.setDate(endDate.getDate() + rental.duration);
          }

          rental.startDate = startDate;
          rental.endDate = endDate;
          await rental.save();

          // Activate the rental via FlowEngine
          await transition("rental", rental._id, "active", {
            activatedBy: "payment_hook",
            orderId: item._id,
          });
          console.log(
            `[FlowHooks] Rental ${rental._id} auto-activated for order ${item._id}`,
          );
        }
      } catch (rentalErr) {
        console.error(
          "[FlowHooks] Rental auto-activation error:",
          rentalErr.message,
        );
      }
    }

    // Send notification to user
    if (item.userId) {
      await sendNotification({
        userId: item.userId,
        title: "Order In Progress",
        message: `Your order #${item.orderNumber || item._id.toString().slice(-6)} is now being processed.`,
        type: "order",
        resourceType: "order",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] order.in_progress error:", err.message);
  }
});

/**
 * Order completed
 * - Send completion notification
 */
on("order.completed", async ({ item }) => {
  loadServices();

  try {
    if (item.userId) {
      await sendNotification({
        userId: item.userId,
        title: "Order Completed",
        message: `Your order #${item.orderNumber || item._id.toString().slice(-6)} has been completed successfully!`,
        type: "order",
        resourceType: "order",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] order.completed error:", err.message);
  }
});

/**
 * PATCH_37: Order cancelled (renamed from rejected)
 * - Send cancellation notification with reason
 */
on("order.cancelled", async ({ item, meta }) => {
  loadServices();

  try {
    if (item.userId) {
      const reason =
        meta.reason || "Please check your order details and try again.";
      await sendNotification({
        userId: item.userId,
        title: "Order Cancelled",
        message: `Your order #${item.orderNumber || item._id.toString().slice(-6)} was cancelled. ${reason}`,
        type: "order",
        resourceType: "order",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] order.cancelled error:", err.message);
  }
});

/**
 * PATCH_37: waiting_user - Payment submitted, awaiting verification
 * - Notify user of submission confirmation
 */
on("order.waiting_user", async ({ item }) => {
  loadServices();

  try {
    if (item.userId) {
      await sendNotification({
        userId: item.userId,
        title: "Payment Submitted",
        message: `Your payment proof for order #${item.orderNumber || item._id.toString().slice(-6)} has been submitted. We will verify it shortly.`,
        type: "order",
        resourceType: "order",
        resourceId: item._id,
        sendEmailCopy: false, // Avoid duplicate emails
      });
    }
  } catch (err) {
    console.error("[FlowHooks] order.waiting_user error:", err.message);
  }
});

// ==============================================
// TICKET HOOKS
// ==============================================

/**
 * Ticket created (open state)
 * - Send confirmation notification
 */
on("ticket.open", async ({ item }) => {
  loadServices();

  try {
    // Notification is handled in the controller during creation
    // This hook is for any additional processing
    console.log(`[FlowHooks] Ticket ${item._id} opened`);
  } catch (err) {
    console.error("[FlowHooks] ticket.open error:", err.message);
  }
});

/**
 * Ticket in progress
 * - Notify user that admin is working on it
 */
on("ticket.in_progress", async ({ item }) => {
  loadServices();

  try {
    if (item.user) {
      await sendNotification({
        userId: item.user,
        title: "Ticket In Progress",
        message: `Your support ticket "${item.subject}" is now being reviewed by our team.`,
        type: "ticket",
        resourceType: "ticket",
        resourceId: item._id,
        sendEmailCopy: false,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] ticket.in_progress error:", err.message);
  }
});

/**
 * Ticket waiting for user
 * - Notify user that response is needed
 */
on("ticket.waiting_user", async ({ item }) => {
  loadServices();

  try {
    if (item.user) {
      await sendNotification({
        userId: item.user,
        title: "Response Required",
        message: `Your support ticket "${item.subject}" requires your response. Please check and reply.`,
        type: "ticket",
        resourceType: "ticket",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] ticket.waiting_user error:", err.message);
  }
});

/**
 * Ticket closed
 * - Send closure notification
 */
on("ticket.closed", async ({ item }) => {
  loadServices();

  try {
    if (item.user) {
      await sendNotification({
        userId: item.user,
        title: "Ticket Closed",
        message: `Your support ticket "${item.subject}" has been closed. If you need further assistance, feel free to open a new ticket.`,
        type: "ticket",
        resourceType: "ticket",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] ticket.closed error:", err.message);
  }
});

// ==============================================
// RENTAL HOOKS
// ==============================================

/**
 * Rental activated
 * - Send activation notification with access details
 */
on("rental.active", async ({ item, previousState }) => {
  loadServices();

  try {
    if (item.user) {
      const message =
        previousState === "renewed"
          ? `Your rental for "${item.serviceName || "subscription"}" has been renewed and is now active until ${new Date(item.endDate).toLocaleDateString()}.`
          : `Your rental for "${item.serviceName || "subscription"}" is now active until ${new Date(item.endDate).toLocaleDateString()}. Access credentials have been sent to your email.`;

      await sendNotification({
        userId: item.user,
        title:
          previousState === "renewed" ? "Rental Renewed" : "Rental Activated",
        message,
        type: "rental",
        resourceType: "rental",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] rental.active error:", err.message);
  }
});

/**
 * Rental expired
 * - Send expiration notification
 */
on("rental.expired", async ({ item }) => {
  loadServices();

  try {
    if (item.user) {
      await sendNotification({
        userId: item.user,
        title: "Rental Expired",
        message: `Your rental for "${item.serviceName || "subscription"}" has expired. Renew now to continue access.`,
        type: "rental",
        resourceType: "rental",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] rental.expired error:", err.message);
  }
});

/**
 * Rental cancelled
 * - Send cancellation confirmation
 */
on("rental.cancelled", async ({ item, meta }) => {
  loadServices();

  try {
    if (item.user) {
      await sendNotification({
        userId: item.user,
        title: "Rental Cancelled",
        message: `Your rental for "${item.serviceName || "subscription"}" has been cancelled.${meta.reason ? ` Reason: ${meta.reason}` : ""}`,
        type: "rental",
        resourceType: "rental",
        resourceId: item._id,
        sendEmailCopy: true,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] rental.cancelled error:", err.message);
  }
});

// ==============================================
// WALLET HOOKS
// ==============================================

/**
 * Wallet transaction completed
 * - Send confirmation notification
 */
on("wallet.completed", async ({ item }) => {
  loadServices();

  try {
    if (item.user) {
      const typeLabel = item.type === "credit" ? "added to" : "deducted from";
      await sendNotification({
        userId: item.user,
        title: "Wallet Transaction",
        message: `$${item.amount.toFixed(2)} has been ${typeLabel} your wallet. New balance: $${item.balanceAfter.toFixed(2)}`,
        type: "wallet",
        resourceType: "wallet",
        resourceId: item._id,
        sendEmailCopy: false,
      });
    }
  } catch (err) {
    console.error("[FlowHooks] wallet.completed error:", err.message);
  }
});

// ==============================================
// GENERIC TRANSITION LOGGING
// ==============================================

/**
 * Log all transitions for analytics/debugging
 */
emitter.on("transition", ({ type, id, from, to, meta, transitionedAt }) => {
  // This could be extended to:
  // - Store in analytics database
  // - Send to external monitoring
  // - Update JarvisX context
  console.log(
    `[FlowEngine:Analytics] ${type}:${id} transitioned ${from} → ${to} at ${transitionedAt.toISOString()}`,
  );
});

console.log("[FlowHooks] Event hooks registered successfully");
