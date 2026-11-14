const express = require("express");
const multer = require("multer");
const auth = require("../middlewares/auth.middleware");
const {
  uploadPaymentProof,
  uploadPayment,
  uploadChatAttachment,
  uploadChatAttachments,
  uploadSingleImage,
} = require("../controllers/upload.controller");
const { CHAT_ALLOWED_TYPES } = require("../middlewares/upload.middleware");

const router = express.Router();

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Invalid file type"), false);
    }
    cb(null, true);
  },
});

// Chat attachment upload (supports images, PDF, ZIP, TXT - max 10MB)
const chatMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!CHAT_ALLOWED_TYPES.includes(file.mimetype)) {
      return cb(
        new Error(
          "Only images, PDF, ZIP, and text files are allowed (max 10MB)",
        ),
        false,
      );
    }
    cb(null, true);
  },
});

// Chat attachment routes - single file
router.post(
  "/chat",
  auth,
  chatMemoryUpload.single("file"),
  uploadChatAttachment,
);

// Chat attachment routes - multiple files (max 5)
router.post(
  "/chat/multiple",
  auth,
  chatMemoryUpload.array("files", 5),
  uploadChatAttachments,
);

// Single image upload (for blogs, profiles, etc.)
router.post("/image", auth, memoryUpload.single("image"), uploadSingleImage);

router.post(
  "/payment-proof",
  auth,
  memoryUpload.single("file"),
  uploadPaymentProof,
);

router.post(
  "/payment-proof/:orderId",
  auth,
  memoryUpload.single("file"),
  uploadPayment,
);

router.post("/", auth, (_req, res) => res.status(410).json({
  message: "For an existing order, upload its proof at /api/upload/payment-proof and submit it on the order payment page.",
}));

module.exports = router;
