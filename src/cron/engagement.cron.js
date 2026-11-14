const User = require("../models/User");
const engagementService = require("../services/engagement.service");
const { getFrontendUrl } = require("../config/frontendUrl");

let emailService;
try {
  emailService = require("../services/email.service");
} catch (err) {
  console.error("[ENGAGEMENT_CRON] Email service not available:", err.message);
  emailService = null;
}

const logger = {
  info: (msg) =>
    console.log(`[ENGAGEMENT_CRON_INFO] ${new Date().toISOString()} ${msg}`),
  warn: (msg) =>
    console.warn(`[ENGAGEMENT_CRON_WARN] ${new Date().toISOString()} ${msg}`),
  error: (msg) =>
    console.error(`[ENGAGEMENT_CRON_ERROR] ${new Date().toISOString()} ${msg}`),
};

const EMAIL_SEND_TIMEOUT = 30000;

/**
 * PATCH_53: Batch email processor cron job
 * Runs every 30 minutes to process queued engagement events
 * Matches users by interests and sends emails respecting preferences
 */
const runEngagementBatch = async () => {
  const batchStartTime = Date.now();

  if (!emailService) {
    logger.warn("Email service unavailable, skipping batch");
    return;
  }

  try {
    logger.info("Batch processor started");

    const events = await engagementService.getUnprocessedEvents();

    if (events.length === 0) {
      logger.info("No unprocessed events found");
      return;
    }

    logger.info(`Processing ${events.length} event(s)`);

    for (const event of events) {
      const locked = await engagementService.acquireEventLock(event._id);
      if (!locked) {
        logger.warn(`Could not acquire lock for event ${event._id}, skipping`);
        continue;
      }

      await processEvent(event);
    }

    const duration = Date.now() - batchStartTime;
    logger.info(`Batch processor completed in ${duration}ms`);
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
  }
};

/**
 * Process a single engagement event
 */
const processEvent = async (event) => {
  try {
    logger.info(`Processing event=${event._id} type=${event.type}`);

    let sentCount = 0;

    const query = {};

    if (event.targetTags && event.targetTags.length > 0) {
      query.interestTags = { $in: event.targetTags };
    }

    const users = await User.find(query).lean();
    logger.info(`Found ${users.length} users for event ${event._id}`);

    for (const user of users) {
      try {
        if (!engagementService.shouldSendEmail(user, event.type)) {
          logger.info(`User ${user._id} opted out of ${event.type}`);
          continue;
        }

        await sendEngagementEmail(user, event);
        sentCount++;
      } catch (emailError) {
        logger.error(
          `Failed to send email to user ${user._id}: ${emailError.message}`,
        );
      }
    }

    await engagementService.markEventProcessed(event._id, sentCount);
    logger.info(`Event ${event._id} processed. Sent to ${sentCount} users`);
  } catch (error) {
    logger.error(`Error processing event ${event._id}: ${error.message}`);
    await engagementService.recordProcessingFailure(event._id, error);
  }
};

/**
 * Send engagement email to user
 */
const sendEngagementEmail = async (user, event) => {
  if (!emailService || !emailService.sendEmail) {
    throw new Error("Email service not available");
  }

  if (!user.email || typeof user.email !== "string") {
    throw new Error("Invalid user email");
  }

  try {
    const subject = `🎉 ${engagementService.sanitizeHtml(event.title)} - New Opportunity on UREMO`;

    const sanitizedTags = (event.targetTags || [])
      .map((tag) => engagementService.sanitizeHtml(tag))
      .join(", ");

    const escapedTitle = engagementService.sanitizeHtml(event.title);
    const escapedMessage = engagementService.sanitizeHtml(event.message);

    const emailBody = `
      <h2>${escapedTitle}</h2>
      <p>${escapedMessage}</p>
      <p>
        <a href="${getFrontendUrl()}" style="background: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
          View on UREMO
        </a>
      </p>
      <p style="color: #666; font-size: 12px;">
        You received this because you're interested in: ${sanitizedTags || "general updates"}
      </p>
      <p style="color: #999; font-size: 11px; margin-top: 20px;">
        <a href="${getFrontendUrl()}/profile">Manage preferences</a>
      </p>
    `;

    const sendPromise = emailService.sendEmail({
      to: user.email,
      subject,
      html: emailBody,
    });

    const result = await Promise.race([
      sendPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Email send timeout")),
          EMAIL_SEND_TIMEOUT,
        ),
      ),
    ]);

    if (!result || result.error) {
      throw new Error(
        `Resend failed: ${result?.error?.message || "Unknown error"}`,
      );
    }

    logger.info(`Email sent to user ${user._id}`);
  } catch (error) {
    logger.error(`Failed to send email: ${error.message}`);
    throw error;
  }
};

module.exports = {
  runEngagementBatch,
};
