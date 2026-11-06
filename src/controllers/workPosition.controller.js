const mongoose = require("mongoose");
const WorkPosition = require("../models/WorkPosition");
const { unavailablePositionIds } = require("../services/opportunityApplications");
const { roleError, withRevision, editRole, removeRole } = require("../services/adminWorkRoles");

const publicPositionFields =
  "title category description requirements serviceId hasScreening screeningId screeningIds active sortOrder createdAt updatedAt";

function roleFields(body, creating) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw roleError(400, "Provide work role fields");
  const limits = { title: 80, category: 48, description: 800, requirements: 1600, adminNotes: 4000 };
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "expectedRevision" && !creating) continue;
    if (Object.hasOwn(limits, key)) {
      if (typeof value !== "string" || value.trim().length > limits[key] ||
          (["title", "category"].includes(key) && !value.trim())) throw roleError(400, "Invalid " + key);
      patch[key] = value.trim();
    } else if (key === "active" && typeof value === "boolean") patch.active = value;
    else if (key === "sortOrder" && Number.isSafeInteger(value)) patch.sortOrder = value;
    else throw roleError(400, "Invalid or unsupported role setting: " + key);
  }
  if (creating && (!patch.title || !patch.category)) throw roleError(400, "Title and category are required");
  if (!Object.keys(patch).length) throw roleError(400, "Provide a work role setting to update");
  return patch;
}

exports.listPublic = async (req, res, next) => {
  try {
    const positions = await WorkPosition.find({ active: true, _id: { $nin: await unavailablePositionIds() } })
      .select(publicPositionFields)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    res.json(positions);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH_47: Get job role by service ID
 * Used when user clicks "Apply to Work" from a service page
 */
exports.getByServiceId = async (req, res, next) => {
  try {
    const { serviceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(serviceId || ""))) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    const position = await WorkPosition.findOne({
      serviceId: serviceId,
      _id: { $nin: await unavailablePositionIds() },
      active: true,
    })
      .select(publicPositionFields)
      .populate("screeningId", "title passingScore timeLimit")
      .lean();

    if (!position) {
      return res.status(404).json({
        message: "No job role found for this service",
        hasJobRole: false,
      });
    }

    res.json({
      hasJobRole: true,
      position,
    });
  } catch (err) {
    next(err);
  }
};

exports.listAdmin = async (req, res, next) => {
  try {
    const positions = await WorkPosition.find()
      .sort({ active: -1, sortOrder: 1, createdAt: -1 })
      .lean();
    res.json(positions.map(withRevision));
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const role = await WorkPosition.create(roleFields(req.body, true));
    res.status(201).json(withRevision(role));
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const patch = roleFields(req.body, false);
    res.json(await editRole(id, req.body.expectedRevision, patch));
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
      return res.status(400).json({ message: "Invalid id" });
    }

    await removeRole(id, req.body?.expectedRevision);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
