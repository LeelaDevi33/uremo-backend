/**
 * PATCH_21: Blog Controller
 * Handles blog CRUD operations for admin and public access
 */

const Blog = require("../models/Blog");

// Helper to generate slug from title
const slugify = (str) => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 100);
};

// Helper for no-cache headers
const setNoCache = (res) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
};

/**
 * CREATE BLOG (Admin only)
 * POST /api/admin/blogs
 */
exports.createBlog = async (req, res) => {
  try {
    const {
      title,
      excerpt,
      content,
      category,
      featuredImage,
      relatedServices,
      status,
      tags,
    } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        ok: false,
        message: "Title and content are required",
      });
    }

    // Generate slug from title
    let slug = slugify(title);

    // Check if slug exists and make unique
    const existingBlog = await Blog.findOne({ slug });
    if (existingBlog) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const blog = await Blog.create({
      title,
      slug,
      excerpt: excerpt || "",
      content,
      category: category || "general",
      featuredImage: featuredImage || "",
      relatedServices: relatedServices || [],
      status: status || "draft",
      tags: tags || [],
      createdBy: req.user?.id || null,
    });

    res.status(201).json({
      ok: true,
      message: "Blog created successfully",
      blog,
    });
  } catch (err) {
    console.error("[Blog] Create error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to create blog",
    });
  }
};

/**
 * UPDATE BLOG (Admin only)
 * PUT /api/admin/blogs/:id
 */
exports.updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      excerpt,
      content,
      category,
      featuredImage,
      relatedServices,
      status,
      tags,
    } = req.body;

    const blog = await Blog.findById(id);
    if (!blog) {
      return res.status(404).json({
        ok: false,
        message: "Blog not found",
      });
    }

    // Update fields
    if (title !== undefined) {
      blog.title = title;
      // Regenerate slug if title changed and slug not explicitly provided
      if (!slug) {
        let newSlug = slugify(title);
        const existingBlog = await Blog.findOne({
          slug: newSlug,
          _id: { $ne: id },
        });
        if (existingBlog) {
          newSlug = `${newSlug}-${Date.now().toString(36)}`;
        }
        blog.slug = newSlug;
      }
    }
    if (slug !== undefined) {
      // Check uniqueness
      const existingBlog = await Blog.findOne({ slug, _id: { $ne: id } });
      if (existingBlog) {
        return res.status(400).json({
          ok: false,
          message: "Slug already exists",
        });
      }
      blog.slug = slug;
    }
    if (excerpt !== undefined) blog.excerpt = excerpt;
    if (content !== undefined) blog.content = content;
    if (category !== undefined) blog.category = category;
    if (featuredImage !== undefined) blog.featuredImage = featuredImage;
    if (relatedServices !== undefined) blog.relatedServices = relatedServices;
    if (status !== undefined) blog.status = status;
    if (tags !== undefined) blog.tags = tags;

    await blog.save();

    res.json({
      ok: true,
      message: "Blog updated successfully",
      blog,
    });
  } catch (err) {
    console.error("[Blog] Update error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to update blog",
    });
  }
};

/**
 * DELETE BLOG (Admin only)
 * DELETE /api/admin/blogs/:id
 */
exports.deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;

    const blog = await Blog.findByIdAndDelete(id);
    if (!blog) {
      return res.status(404).json({
        ok: false,
        message: "Blog not found",
      });
    }

    res.json({
      ok: true,
      message: "Blog deleted successfully",
    });
  } catch (err) {
    console.error("[Blog] Delete error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to delete blog",
    });
  }
};

/**
 * GET ALL BLOGS (Admin - includes drafts)
 * GET /api/admin/blogs
 */
exports.getAllBlogsAdmin = async (req, res) => {
  try {
    setNoCache(res);

    const { status, category, limit = 100, page = 1 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;

    const take = Math.min(parseInt(limit) || 100, 200);
    const skip = (parseInt(page) - 1) * take;

    const blogs = await Blog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .populate("createdBy", "name email")
      .lean();

    const total = await Blog.countDocuments(filter);

    res.json({
      ok: true,
      blogs,
      meta: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error("[Blog] GetAll Admin error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to fetch blogs",
    });
  }
};

/**
 * GET PUBLIC BLOGS (Published only)
 * GET /api/blogs
 */
exports.getPublicBlogs = async (req, res) => {
  try {
    setNoCache(res);

    const { category, limit = 20, page = 1, search } = req.query;

    const filter = { status: "published" };
    if (category && category !== "all") filter.category = category;

    // Search in title and excerpt
    if (search) {
      const searchRegex = new RegExp(search, "i");
      filter.$or = [{ title: searchRegex }, { excerpt: searchRegex }];
    }

    const take = Math.min(parseInt(limit) || 20, 50);
    const skip = (parseInt(page) - 1) * take;

    const blogs = await Blog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .select("-content") // Don't send full content in list
      .lean();

    const total = await Blog.countDocuments(filter);

    // Get available categories for filtering
    const categories = await Blog.distinct("category", { status: "published" });

    res.json({
      ok: true,
      blogs,
      filters: {
        categories,
      },
      meta: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error("[Blog] GetPublic error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to fetch blogs",
    });
  }
};

/**
 * GET SINGLE BLOG BY SLUG (Public)
 * GET /api/blogs/:slug
 */
exports.getBlogBySlug = async (req, res) => {
  try {
    setNoCache(res);

    const { slug } = req.params;

    const blog = await Blog.findOne({ slug, status: "published" })
      .populate("createdBy", "name")
      .lean();

    if (!blog) {
      return res.status(404).json({
        ok: false,
        message: "Blog not found",
      });
    }

    // Increment view count (fire and forget)
    Blog.updateOne({ _id: blog._id }, { $inc: { viewCount: 1 } }).catch(
      () => {},
    );

    res.json({
      ok: true,
      blog: {
        ...blog,
        relatedServices: [],
      },
    });
  } catch (err) {
    console.error("[Blog] GetBySlug error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to fetch blog",
    });
  }
};

/**
 * GET SINGLE BLOG BY ID (Admin - includes drafts)
 * GET /api/admin/blogs/:id
 */
exports.getBlogByIdAdmin = async (req, res) => {
  try {
    setNoCache(res);

    const { id } = req.params;

    const blog = await Blog.findById(id)
      .populate("createdBy", "name email")
      .populate("relatedServices", "_id title slug price")
      .lean();

    if (!blog) {
      return res.status(404).json({
        ok: false,
        message: "Blog not found",
      });
    }

    res.json({
      ok: true,
      blog,
    });
  } catch (err) {
    console.error("[Blog] GetById Admin error:", err);
    res.status(500).json({
      ok: false,
      message: err.message || "Failed to fetch blog",
    });
  }
};
