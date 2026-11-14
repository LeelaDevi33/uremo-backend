const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendEmail } = require("./email.service");
const { escapeHtml } = require("../emails/templates");
const { getFrontendUrl } = require("../config/frontendUrl");

/**
 * Send a notification to a user (in-app + email)
 * @param {Object} params
 * @param {string} params.userId - User ObjectId
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification message
 * @param {string} params.type - Type: order|ticket|wallet|affiliate|rental|system
 * @param {string} [params.resourceType] - Optional: order|ticket|rental|withdrawal
 * @param {string} [params.resourceId] - Optional: ObjectId of related resource
 * @param {boolean} [params.sendEmailCopy=true] - Whether to send email copy
 */
async function sendNotification({
  userId,
  title,
  message,
  type = "system",
  resourceType = null,
  resourceId = null,
  sendEmailCopy = true,
}) {
  try {
    // Create in-app notification
    const notification = await Notification.create({
      user: userId,
      title,
      message,
      type,
      resourceType,
      resourceId,
    });

    // Send email copy if enabled
    if (sendEmailCopy) {
      try {
        const user = await User.findById(userId)
          .select("email firstName")
          .lean();
        if (user?.email) {
          await sendEmail({
            to: user.email,
            subject: `[UREMO] ${title}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #10B981;">${escapeHtml(title)}</h2>
                <p style="color: #374151; font-size: 16px;">${escapeHtml(message)}</p>
                <hr style="border: 1px solid #E5E7EB; margin: 20px 0;" />
                <p style="color: #9CA3AF; font-size: 12px;">
                  This is an automated notification from UREMO.
                  <br />
                  <a href="${getFrontendUrl()}" style="color: #10B981;">
                    Visit Dashboard
                  </a>
                </p>
              </div>
            `,
            text: `${title}\n\n${message}\n\n---\nThis is an automated notification from UREMO.`,
          });
        }
      } catch (emailErr) {
        // Log email error but don't fail the notification
        console.error(
          "[notification.service] Email send failed:",
          emailErr.message,
        );
      }
    }

    return notification;
  } catch (err) {
    console.error(
      "[notification.service] Failed to create notification:",
      err.message,
    );
    throw err;
  }
}

/**
 * Get unread notification count for a user
 */
async function getUnreadCount(userId) {
  return Notification.countDocuments({ user: userId, isRead: false });
}

/**
 * Mark notification as read
 */
async function markAsRead(notificationId, userId) {
  return Notification.findOneAndUpdate(
    { _id: notificationId, user: userId },
    { isRead: true },
    { new: true },
  );
}

/**
 * Mark all notifications as read for a user
 */
async function markAllAsRead(userId) {
  return Notification.updateMany(
    { user: userId, isRead: false },
    { isRead: true },
  );
}

/**
 * Get notifications for a user with pagination
 */
async function getNotifications(userId, { page = 1, limit = 50 } = {}) {
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments({ user: userId }),
    Notification.countDocuments({ user: userId, isRead: false }),
  ]);

  return {
    notifications,
    total,
    unreadCount,
    page,
    pages: Math.ceil(total / limit),
  };
}

module.exports = {
  sendNotification,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getNotifications,
};
