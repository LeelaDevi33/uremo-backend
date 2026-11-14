const Order = require("../models/Order");
const Service = require("../models/Service");
const PaymentMethod = require("../models/PaymentMethod");

exports.getActivePaymentMethods = async (req, res) => {
  try {
    const methods = await PaymentMethod.find({ active: true });
    res.json(methods);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.checkout = async (req, res) => {
  try {
    // Lazy-load Stripe to avoid importing it on server startup
    if (
      !process.env.STRIPE_SECRET_KEY ||
      process.env.STRIPE_SECRET_KEY.trim() === ""
    ) {
      return res
        .status(503)
        .json({ message: "Payments are temporarily disabled" });
    }
    const stripe = require("../config/stripe");

    const service = await Service.findById(req.body.serviceId);
    if (!service) return res.status(404).json({ message: "Service not found" });
    const order = await Order.create({
      userId: req.user.id,
      serviceId: service._id,
      quotedAmount: service.price,
      quotedCurrency: service.currency || "USD",
      status: "pending",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: service.name },
            unit_amount: Math.round(service.price * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/payment-success?orderId=${order._id}`,
      cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
