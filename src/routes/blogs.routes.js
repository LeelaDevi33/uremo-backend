/**
 * PATCH_21: Blog Routes
 * Public and Admin routes for blog management
 */

const express = require("express");
const router = express.Router();
const blogsController = require("../controllers/blogs.controller");
const { protect } = require("../middlewares/auth.middleware");
const { requireAdmin } = require("../middlewares/admin.middleware");

// ============================================
// PUBLIC ROUTES (No auth required)
// ============================================

// GET /api/blogs - List published blogs
router.get("/", blogsController.getPublicBlogs);

// GET /api/blogs/:slug - Get single blog by slug
router.get("/:slug", blogsController.getBlogBySlug);
router.post("/:slug/view", blogsController.recordView);

module.exports = router;
