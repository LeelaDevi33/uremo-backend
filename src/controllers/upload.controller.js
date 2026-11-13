const cloudinary = require("../config/cloudinary");
const { inferResourceType } = require("../utils/cloudinaryUrl");
const { getFileCategory } = require("../middlewares/upload.middleware");

function serializeUpload(uploadResult) {
  if (!uploadResult) return null;
  return {
    url: uploadResult.secure_url,
    publicId: uploadResult.public_id,
    resourceType: uploadResult.resource_type,
    format: uploadResult.format,
  };
}

/**
 * Upload a single file for chat attachments (tickets or order messages)
 * POST /api/uploads/chat
 * Returns: { url, filename, fileType, publicId, size }
 */
exports.uploadChatAttachment = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "File required" });
    }

    const file = req.file;
    const fileCategory = getFileCategory(file.mimetype);
    const resourceType = inferResourceType({ mimeType: file.mimetype });

    // Use stream upload for buffer
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "uremo/chat-attachments",
        resource_type: resourceType,
        // For raw files (zip, txt), we still upload as raw
        ...(fileCategory === "archive" || fileCategory === "text"
          ? { resource_type: "raw" }
          : {}),
      },
      (error, uploadResult) => {
        if (error) {
          console.error("Chat attachment upload error:", error);
          return res.status(500).json({ message: "Upload failed" });
        }

        res.json({
          url: uploadResult.secure_url,
          filename: file.originalname,
          fileType: fileCategory,
          publicId: uploadResult.public_id,
          size: file.size,
        });
      },
    );

    uploadStream.end(file.buffer);
  } catch (err) {
    console.error("uploadChatAttachment error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Upload multiple files for chat attachments (tickets or order messages)
 * POST /api/uploads/chat/multiple
 * Returns: { attachments: [{ url, filename, fileType, publicId, size }] }
 */
exports.uploadChatAttachments = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "At least one file required" });
    }

    const uploadPromises = req.files.map((file) => {
      return new Promise((resolve, reject) => {
        const fileCategory = getFileCategory(file.mimetype);
        const resourceType =
          fileCategory === "archive" || fileCategory === "text"
            ? "raw"
            : inferResourceType({ mimeType: file.mimetype });

        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "uremo/chat-attachments",
            resource_type: resourceType,
          },
          (error, uploadResult) => {
            if (error) {
              return reject(error);
            }
            resolve({
              url: uploadResult.secure_url,
              filename: file.originalname,
              fileType: fileCategory,
              publicId: uploadResult.public_id,
              size: file.size,
            });
          },
        );

        uploadStream.end(file.buffer);
      });
    });

    const attachments = await Promise.all(uploadPromises);
    res.json({ attachments });
  } catch (err) {
    console.error("uploadChatAttachments error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadImages = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No images uploaded" });
    }

    const uploads = await Promise.all(
      req.files.map((file) =>
        cloudinary.uploader.upload(file.path, {
          folder: "uremo/services",
        }),
      ),
    );

    const files = uploads.map(serializeUpload).filter(Boolean);
    const urls = files.map((f) => f.url);
    res.json({ urls, files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadPaymentProof = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "File required" });
    }

    const resourceType = inferResourceType({ mimeType: req.file.mimetype });
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "uremo/payments",
        resource_type: resourceType,
      },
      (error, uploadResult) => {
        if (error) {
          console.error(error);
          return res.status(500).json({ message: "Upload failed" });
        }

        const payload = serializeUpload(uploadResult);
        res.json(payload);
      },
    );

    uploadStream.end(req.file.buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.uploadPayment = async (req, res) => {
  try {
    // Legacy endpoint: only uploads the file and returns a URL.
    // Order status transitions must go through PUT /api/orders/:id/payment.

    if (!req.file) {
      return res.status(400).json({ message: "File required" });
    }

    // Upload to Cloudinary
    const resourceType = inferResourceType({ mimeType: req.file.mimetype });
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "uremo/payments",
        resource_type: resourceType,
      },
      async (error, uploadResult) => {
        if (error) {
          console.error(error);
          return res.status(500).json({ message: "Upload failed" });
        }

        const payload = serializeUpload(uploadResult);
        res.json(payload);
      },
    );

    uploadStream.end(req.file.buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Upload a single image (for blogs, profiles, etc.)
 * POST /api/upload/image
 * Returns: { ok, url, publicId }
 */
exports.uploadSingleImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Image required" });
    }

    const file = req.file;
    const resourceType = inferResourceType({ mimeType: file.mimetype });

    // Use stream upload for buffer
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "uremo/images",
        resource_type: resourceType,
      },
      (error, uploadResult) => {
        if (error) {
          console.error("Image upload error:", error);
          return res.status(500).json({ ok: false, message: "Upload failed" });
        }

        const result = serializeUpload(uploadResult);
        res.json({
          ok: true,
          url: result.url,
          publicId: result.publicId,
          format: result.format,
        });
      },
    );

    uploadStream.end(file.buffer);
  } catch (err) {
    console.error("uploadSingleImage error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
};
