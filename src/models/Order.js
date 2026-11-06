const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "in_progress",
        "waiting_user",
        "completed",
        "cancelled",
      ],
      default: "pending",
    },

    // PATCH_38: Action type (buy / rental / deal)
    orderType: {
      type: String,
      enum: ["buy", "rental", "deal"],
      default: "buy",
      index: true,
    },

    // PATCH_112: Payment tracking fields (critical for double-pay prevention)
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded"],
      default: "unpaid",
      index: true,
    },
    // Keep the accepted price even if the service or rental plan is edited later.
    quotedAmount: { type: Number, min: 0, immutable: true },
    quotedCurrency: { type: String, uppercase: true, trim: true, immutable: true },
    settledAmount: { type: Number, min: 0 },
    settledCurrency: { type: String, uppercase: true, trim: true },
    paymentMethod: {
      type: String,
      enum: ["wallet", "paypal", "manual", "stripe"],
      default: null,
    },

    // PATCH_38: Deal metadata
    dealPercent: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },

    // PATCH_92: Link back to Rental record for rental orders
    rentalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Rental",
      default: null,
    },

    // PATCH_92: Country for rental/deal orders
    country: {
      type: String,
      default: null,
    },

    // Draft orders (pending) can expire automatically (cleanup job can remove them later)
    expiresAt: {
      type: Date,
      default: null,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    // PATCH_31: Track when order was completed
    completedAt: {
      type: Date,
      default: null,
    },

    payment: {
      methodId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PaymentMethod",
      },
      reference: String,
      proofUrl: String,
      proofPublicId: String,
      proofResourceType: {
        type: String,
        enum: ["image", "raw"],
      },
      proofFormat: String,
      submittedAt: Date,
      verifiedAt: Date,
    },

    statusLog: [
      {
        text: { type: String, required: true },
        at: { type: Date, default: Date.now },
      },
    ],

    timeline: [
      {
        message: String,
        by: {
          type: String,
          enum: ["system", "admin"],
          default: "system",
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    assignedWorker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    notes: {
      type: String,
    },

    // FIX_PACK_02_REJECTED_CHAT_ORDERS_GREEN
    // When true, a cancelled order is moved to the admin's "Cancelled Orders" list.
    // This does not delete the order; it just hides it from the default admin list.
    isRejectedArchive: {
      type: Boolean,
      default: false,
      index: true,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },

    // EMAIL_AUTOMATION_PACK_01
    // Used by the cron reminder endpoint to avoid spamming users.
    reminderSent: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Order", orderSchema);
