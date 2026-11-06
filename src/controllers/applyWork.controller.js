const ApplyWork = require("../models/ApplyWork");
const { randomUUID } = require("node:crypto");
const { createRoleApplication, preflightApplication } = require("../services/opportunityApplications");
const cloudinary = require("../config/cloudinary");
const {
  inferResourceType,
  normalizeCloudinaryUrl,
} = require("../utils/cloudinaryUrl");
const mongoose = require("mongoose");
const WorkPosition = require("../models/WorkPosition");

const User = require("../models/User");
const { sendEmail, getAdminEmails } = require("../services/email.service");
const {
  applicationSubmittedEmail,
  adminNewApplicationAlert,
} = require("../emails/templates");

exports.apply = async (req, res, next) => {
  let pendingUpload = null;
  try {
    const positionIdRaw = String(req.body?.positionId || "").trim();

    let position = null;
    if (positionIdRaw) {
      if (!mongoose.Types.ObjectId.isValid(positionIdRaw)) {
        return res.status(400).json({ message: "Invalid positionId" });
      }
      position = await WorkPosition.findById(positionIdRaw).lean();
      if (!position) {
        return res.status(400).json({ message: "Position not found" });
      }
      // Reject closed roles before sending a resume to storage. Eligibility is
      // checked again inside the application transaction in case a sale races the upload.
      await preflightApplication(position, req.user.id);
    }

    const category = position
      ? String(position.category || "").trim()
      : String(req.body?.category || "").trim();
    if (!category) {
      return res.status(400).json({ message: "Category is required" });
    }

    const resumeUrlRaw = String(req.body?.resumeUrl || "").trim();
    if (!req.file && !resumeUrlRaw) {
      return res
        .status(400)
        .json({ message: "Resume required (file upload or resumeUrl)" });
    }

    let resumeDoc = {};

    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        const resourceType = inferResourceType({ mimeType: req.file.mimetype });
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: resourceType,
            folder: "uremo/resumes",
            public_id: randomUUID(),
          },
          (error, uploadResult) => {
            if (error) return reject(error);
            resolve(uploadResult);
          },
        );

        uploadStream.end(req.file.buffer);
      });

      resumeDoc = {
        resumeUrl: result.secure_url,
        resumePublicId: result.public_id,
        resumeResourceType: result.resource_type,
        resumeFormat: result.format,
        resumeOriginalName: req.file.originalname,
        resumeMimeType: req.file.mimetype,
      };
      pendingUpload = { id: result.public_id, type: result.resource_type };
    } else {
      resumeDoc = {
        resumeUrl: resumeUrlRaw,
        resumeOriginalName: String(req.body?.resumeOriginalName || "").trim(),
        resumeMimeType: String(req.body?.resumeMimeType || "").trim(),
      };
    }

    const application = await createRoleApplication({
      user: req.user.id,
      position: position ? position._id : undefined,
      positionTitle: position ? String(position.title || "").trim() : "",
      category,
      ...resumeDoc,
      message: req.body.message,
    });
    pendingUpload = null;

    // Email notifications (best-effort)
    try {
      const user = await User.findById(req.user.id).select("email name").lean();
      const userEmail = user?.email;
      const userName = user?.name;

      const label = position
        ? String(position.title || "").trim() || category
        : category;

      if (userEmail) {
        await sendEmail({
          to: userEmail,
          subject: "Application submitted — UREMO",
          html: applicationSubmittedEmail({ name: userName, category: label }),
        });
      }

      const admins = getAdminEmails();
      if (admins.length) {
        await sendEmail({
          to: admins,
          subject: "Admin alert: new application",
          html: adminNewApplicationAlert({
            userEmail: userEmail || "",
            category: label,
          }),
        });
      }
    } catch (err) {
      console.error("[email] application submitted hooks failed", {
        userId: String(req.user.id),
        message: err?.message || String(err),
      });
    }

    res.status(201).json(application);
  } catch (err) {
    if (pendingUpload && !err.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      try {
        await cloudinary.uploader.destroy(pendingUpload.id, { resource_type: pendingUpload.type });
      } catch (cleanupError) {
        console.error("[applyWork] resume cleanup failed", pendingUpload.id, cleanupError.name);
      }
    }
    next(err);
  }
};

exports.getAll = async (req, res, next) => {
  try {
    // Parse filters from query params
    const { status, category, search, page = 1, limit = 50 } = req.query;

    const filter = {};

    // Status filter
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      filter.status = status;
    }

    // Category filter (supports: microjob_worker, outlier, writerbay, coding_math, other)
    if (category) {
      const categoryLower = category.toLowerCase();
      if (categoryLower === "microjob_worker") {
        filter.category = { $regex: /microjob|worker/i };
      } else if (categoryLower === "outlier") {
        filter.$or = [
          { category: { $regex: /outlier/i } },
          { positionTitle: { $regex: /outlier/i } },
        ];
      } else if (categoryLower === "writerbay") {
        filter.$or = [
          { category: { $regex: /writerbay|writer/i } },
          { positionTitle: { $regex: /writerbay|writer/i } },
        ];
      } else if (categoryLower === "coding_math") {
        filter.$or = [
          { category: { $regex: /coding|math|expert/i } },
          { positionTitle: { $regex: /coding|math|expert/i } },
        ];
      } else if (categoryLower !== "all") {
        filter.category = { $regex: new RegExp(category, "i") };
      }
    }

    // Pagination
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const limitNum = Math.min(parseInt(limit, 10), 100);

    // Build the query
    let query = ApplyWork.find(filter);

    // If search is provided, we need to filter by user email/name after populate
    const apps = await query
      .populate("user", "email name")
      .populate("position", "_id title category active")
      .sort({ createdAt: -1 })
      .lean();

    // Filter by search (user email or name) - done after populate
    let filtered = apps;
    if (search && search.trim()) {
      const searchLower = search.toLowerCase().trim();
      filtered = apps.filter(
        (app) =>
          app.user?.email?.toLowerCase().includes(searchLower) ||
          app.user?.name?.toLowerCase().includes(searchLower),
      );
    }

    // Get total before pagination
    const total = filtered.length;

    // Apply pagination
    const paginated = filtered.slice(skip, skip + limitNum);

    const normalized = paginated.map((app) => ({
      ...app,
      resumeUrl: normalizeCloudinaryUrl(app.resumeUrl, {
        mimeType: app.resumeMimeType,
        resourceType: app.resumeResourceType,
      }),
    }));

    res.json({
      applications: normalized,
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / limitNum),
      // Include filter options for frontend
      filterOptions: {
        statuses: ["pending", "approved", "rejected"],
        categories: [
          { value: "all", label: "All Categories" },
          { value: "microjob_worker", label: "Microjob Worker" },
          { value: "outlier", label: "Outlier Writing Jobs" },
          { value: "writerbay", label: "WriterBay Platform" },
          { value: "coding_math", label: "Coding / Math Expert" },
          { value: "other", label: "Other" },
        ],
      },
    });
  } catch (err) {
    next(err);
  }
};

// PATCH_57: Enhanced updateStatus to also update workerStatus when approving
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body;

    // Get the application first
    const app = await ApplyWork.findById(req.params.id);
    if (!app) {
      return res
        .status(404)
        .json({ success: false, message: "Application not found" });
    }

    app.status = status;

    // PATCH_57: If approving, update workerStatus based on screening availability
    if (status === "approved") {
      // Check if the position has screening
      if (app.position) {
        const WorkPosition = require("../models/WorkPosition");
        const job = await WorkPosition.findById(app.position)
          .select("hasScreening screeningId")
          .lean();

        if (job?.hasScreening && job?.screeningId) {
          app.workerStatus = "screening_unlocked";
        } else {
          app.workerStatus = "ready_to_work";
        }
      } else {
        // No position linked - default to ready_to_work
        app.workerStatus = "ready_to_work";
      }
    }

    await app.save();
    res.json({ success: true, workerStatus: app.workerStatus });
  } catch (err) {
    next(err);
  }
};

exports.getMyApplication = async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const filter = { user: req.user.id };
    if (req.query.positionId !== undefined) {
      if (!mongoose.isObjectIdOrHexString(req.query.positionId)) {
        return res.status(400).json({ message: "Invalid positionId" });
      }
      filter.position = req.query.positionId;
    }
    const app = await ApplyWork.findOne(filter)
      .sort({ createdAt: -1, _id: -1 })
      .populate("position", "_id title category active")
      .lean();
    if (!app) return res.json(null);
    res.json({
      ...app,
      resumeUrl: normalizeCloudinaryUrl(app.resumeUrl, {
        mimeType: app.resumeMimeType,
        resourceType: app.resumeResourceType,
      }),
    });
  } catch (err) {
    next(err);
  }
};
