const express = require("express");
const multer = require("multer");
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const {
  applyWork,
  listApplications,
  updateApplication,
} = require("../controllers/worker.controller");

const router = express.Router();
const upload = multer({
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

router.post("/apply", auth, upload.single("resume"), applyWork);
router.get("/admin", auth, admin, listApplications);
router.put("/admin/:id", auth, admin, updateApplication);

module.exports = router;
