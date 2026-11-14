const express = require("express");
const retiredCatalog = require("../middlewares/retiredCatalog");
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const {
  getAllServices,
} = require("../controllers/service.controller");

const router = express.Router();

// Public routes
router.get("/", retiredCatalog);

// PATCH_59: Unified Intent-Based Marketplace API
router.get("/marketplace", retiredCatalog);
router.get("/marketplace/filters", retiredCatalog);

// PATCH_38: Guarded list endpoints
router.get("/workspace", retiredCatalog);
router.get("/deals", retiredCatalog);

// Admin routes
// IMPORTANT: keep static admin paths above '/:id' to avoid being captured as an id.
router.get("/admin/all", auth, admin, getAllServices);

// PATCH_38: Actions endpoint (must be above '/:id')
router.get("/:id/actions", retiredCatalog);

router.get("/:id", retiredCatalog);

router.post("/", auth, admin, retiredCatalog);
router.put("/:id", auth, admin, retiredCatalog);
router.delete("/:id", auth, admin, retiredCatalog);

module.exports = router;
