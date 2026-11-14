const Order = require("../models/Order");

const { sendEmail } = require("../services/email.service");
const { paymentPendingReminder } = require("../emails/templates");

exports.paymentPendingReminders = async (req, res) => {
  try {
    const header = req.get("Authorization") || "";
    const secret = /^Bearer /i.test(header) ? header.slice(7) : req.query?.secret;
    const expected =
      process.env.CRON_SECRET || process.env.CRON_PAYMENT_PENDING_SECRET || "";

    if (!expected) {
      return res.status(404).json({ message: "Route not found" });
    }

    if (!secret || secret !== expected) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // PATCH_37: normalized to "pending" status
    const candidates = await Order.find({
      status: "pending",
      reminderSent: { $ne: true },
      createdAt: { $lte: cutoff },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate("userId", "email name")
      .populate("serviceId", "title price")
      .lean();

    let attempted = 0;
    let sent = 0;
    let skipped = 0;

    for (const order of candidates) {
      const userEmail = order?.userId?.email;
      if (!userEmail) {
        skipped += 1;
        continue;
      }

      attempted += 1;

      try {
        await sendEmail({
          to: userEmail,
          subject: "Reminder: payment pending — UREMO",
          html: paymentPendingReminder(order),
        });

        await Order.updateOne(
          { _id: order._id, reminderSent: { $ne: true } },
          { $set: { reminderSent: true } },
        );

        sent += 1;
      } catch (err) {
        // Best-effort; do not mark as sent on failure.
        console.error("[email] payment pending reminder failed", {
          orderId: String(order?._id),
          userEmail,
          message: err?.message || String(err),
        });
      }
    }

    return res.json({
      ok: true,
      cutoff,
      found: candidates.length,
      attempted,
      sent,
      skipped,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
};
