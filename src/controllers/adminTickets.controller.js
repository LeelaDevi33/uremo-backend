const Ticket = require("../models/Ticket");
const TicketMessage = require("../models/TicketMessage");
const { sendNotification } = require("../services/notification.service");

// PATCH_31: FlowEngine for orchestrated state transitions
const FlowEngine = require("../core/flowEngine");

// Get all tickets with filters
exports.getAllTickets = async (req, res) => {
  try {
    const {
      status,
      category,
      priority,
      search,
      hasUnread,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = {};

    if (status && status !== "all") {
      filter.status = status;
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    if (priority && priority !== "all") {
      filter.priority = priority;
    }
    if (hasUnread === "true") {
      filter.hasUnreadAdmin = true;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let ticketsQuery = Ticket.find(filter)
      .populate("user", "firstName lastName name email")
      .populate("order", "orderNumber status")
      .populate("assignedAdmin", "firstName lastName name email")
      .sort({ hasUnreadAdmin: -1, lastMessageAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const [tickets, total, stats] = await Promise.all([
      ticketsQuery.lean(),
      Ticket.countDocuments(filter),
      Ticket.aggregate([
        {
          $group: {
            _id: null,
            open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
            inProgress: {
              $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] },
            },
            waitingUser: {
              $sum: { $cond: [{ $eq: ["$status", "waiting_user"] }, 1, 0] },
            },
            closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
            unread: { $sum: { $cond: ["$hasUnreadAdmin", 1, 0] } },
          },
        },
      ]),
    ]);

    // Apply search filter on populated fields
    let filteredTickets = tickets;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredTickets = tickets.filter(
        (t) =>
          t.subject?.toLowerCase().includes(searchLower) ||
          t.user?.email?.toLowerCase().includes(searchLower) ||
          t.user?.name?.toLowerCase().includes(searchLower),
      );
    }

    res.json({
      ok: true,
      tickets: filteredTickets,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      stats: stats[0] || {
        open: 0,
        inProgress: 0,
        waitingUser: 0,
        closed: 0,
        unread: 0,
      },
    });
  } catch (err) {
    console.error("getAllTickets error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Get single ticket for admin
exports.getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate("user", "firstName lastName name email")
      .populate("order", "orderNumber status totalAmount")
      .populate("assignedAdmin", "firstName lastName name email")
      .lean();

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    // Mark as read by admin
    await Ticket.findByIdAndUpdate(req.params.id, { hasUnreadAdmin: false });

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error("getTicketById error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Get ticket messages for admin
exports.getTicketMessages = async (req, res) => {
  try {
    const messages = await TicketMessage.find({ ticket: req.params.id })
      .populate("sender", "firstName lastName name email")
      .sort({ createdAt: 1 })
      .lean();

    // Mark as read by admin
    await Ticket.findByIdAndUpdate(req.params.id, { hasUnreadAdmin: false });

    res.json({ ok: true, messages });
  } catch (err) {
    console.error("getTicketMessages error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Reply to ticket (admin)
exports.replyTicketAdmin = async (req, res) => {
  try {
    const { message, attachment, attachments } = req.body;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    // Validate attachments array if provided
    const validAttachments = Array.isArray(attachments)
      ? attachments.filter(
          (att) =>
            att &&
            typeof att.url === "string" &&
            typeof att.filename === "string" &&
            typeof att.fileType === "string",
        )
      : [];

    const adminId = req.user?.id || req.user?._id;
    const msg = await TicketMessage.create({
      ticket: req.params.id,
      senderType: "admin",
      sender: adminId,
      message,
      attachments: validAttachments,
      // Legacy field support
      attachment: attachment || null,
    });

    // Build update data
    const updateData = {
      lastMessageAt: new Date(),
      hasUnreadAdmin: false,
      hasUnreadUser: true,
      status: { $cond: [{ $eq: ["$status", "open"] }, "in_progress", "$status"] },
      firstResponseAt: { $ifNull: ["$firstResponseAt", "$$NOW"] },
    };

    // Track first admin response for SLA
    const updated = await Ticket.findByIdAndUpdate(req.params.id, [{ $set: updateData }], { new: true, updatePipeline: true }).select("status");

    // PATCH_29: Send notification to user about admin reply
    try {
      await sendNotification({
        userId: ticket.user,
        title: "Support Reply",
        message: `Our team has responded to your ticket "${ticket.subject}". Please check your ticket for details.`,
        type: "ticket",
        resourceType: "ticket",
        resourceId: ticket._id,
      });
    } catch (notifErr) {
      console.error("[notification] admin reply failed:", notifErr.message);
    }

    res.json({ ok: true, message: msg, status: updated.status });
  } catch (err) {
    console.error("replyTicketAdmin error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Update ticket status
exports.updateTicketStatus = async (req, res) => {
  try {
    const { status, priority, reason } = req.body;

    // Handle priority-only update
    if (!status && priority) {
      const ticket = await Ticket.findByIdAndUpdate(
        req.params.id,
        { priority },
        { new: true },
      )
        .populate("user", "firstName lastName name email")
        .populate("assignedAdmin", "firstName lastName name email");

      if (!ticket) {
        return res.status(404).json({ message: "Ticket not found" });
      }
      return res.json({ ok: true, ticket });
    }

    // PATCH_31: Use FlowEngine for status transitions
    if (status) {
      const canTransitionResult = await FlowEngine.canTransition(
        "ticket",
        req.params.id,
        status,
      );

      if (!canTransitionResult.allowed) {
        return res.status(400).json({
          message: canTransitionResult.reason || "Invalid status transition",
          currentStatus: canTransitionResult.currentState,
        });
      }

      const ticket = await FlowEngine.transition(
        "ticket",
        req.params.id,
        status,
        {
          actor: "admin",
          adminId: req.user?._id || req.user?.id,
          reason: reason || `Status changed to ${status}`,
        },
      );

      // Update priority if provided
      if (priority) {
        ticket.priority = priority;
        await ticket.save();
      }

      await ticket.populate([
        { path: "user", select: "firstName lastName name email" },
        { path: "assignedAdmin", select: "firstName lastName name email" },
      ]);

      return res.json({ ok: true, ticket });
    }

    return res.status(400).json({ message: "Status or priority required" });
  } catch (err) {
    console.error("updateTicketStatus error:", err);
    if (err.message?.includes("Invalid transition")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
};

// Assign ticket to admin
exports.assignTicket = async (req, res) => {
  try {
    const { adminId } = req.body;

    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      { assignedAdmin: adminId || null },
      { new: true },
    )
      .populate("user", "firstName lastName name email")
      .populate("assignedAdmin", "firstName lastName name email");

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error("assignTicket error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Close ticket
exports.closeTicket = async (req, res) => {
  try {
    const { reason } = req.body;

    // PATCH_31: Use FlowEngine for status transition
    const canTransitionResult = await FlowEngine.canTransition(
      "ticket",
      req.params.id,
      "closed",
    );

    if (!canTransitionResult.allowed) {
      return res.status(400).json({
        message: canTransitionResult.reason || "Cannot close this ticket",
        currentStatus: canTransitionResult.currentState,
      });
    }

    const ticket = await FlowEngine.transition(
      "ticket",
      req.params.id,
      "closed",
      {
        actor: "admin",
        adminId: req.user?._id || req.user?.id,
        reason: reason || "Ticket closed by admin",
      },
    );

    await ticket.populate("user", "name email");

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error("closeTicket error:", err);
    if (err.message?.includes("Invalid transition")) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
};

// Get admin users list (for assignment dropdown)
exports.getAdminUsers = async (req, res) => {
  try {
    const User = require("../models/User");
    const admins = await User.find({ role: "admin" })
      .select("firstName lastName name email")
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    res.json({ ok: true, admins });
  } catch (err) {
    console.error("getAdminUsers error:", err);
    res.status(500).json({ message: err.message });
  }
};

// Get unread count for admin
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Ticket.countDocuments({ hasUnreadAdmin: true });
    res.json({ ok: true, unreadCount: count });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    res.status(500).json({ message: err.message });
  }
};

// PATCH_35: Add internal note
exports.addInternalNote = async (req, res) => {
  try {
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ message: "Note is required" });
    }

    const adminId = req.user?.id || req.user?._id;

    const ticket = await Ticket.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          internalNotes: {
            note: note.trim(),
            createdBy: adminId,
            createdAt: new Date(),
          },
        },
      },
      { new: true },
    ).populate("internalNotes.createdBy", "firstName lastName name email");

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json({ ok: true, internalNotes: ticket.internalNotes });
  } catch (err) {
    console.error("addInternalNote error:", err);
    res.status(500).json({ message: err.message });
  }
};

// PATCH_35: Get internal notes
exports.getInternalNotes = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .select("internalNotes")
      .populate("internalNotes.createdBy", "firstName lastName name email")
      .lean();

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json({ ok: true, internalNotes: ticket.internalNotes || [] });
  } catch (err) {
    console.error("getInternalNotes error:", err);
    res.status(500).json({ message: err.message });
  }
};
