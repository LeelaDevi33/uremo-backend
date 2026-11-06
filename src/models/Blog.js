/**
 * PATCH_21: Blog Model for Content Marketing
 * Supports SEO-driven content with service linking
 */

const mongoose = require("mongoose");

const BLOG_CATEGORIES = [
  "opportunities",
  "microjobs",
  "forex_crypto",
  "banks_wallets",
  "guides",
  "general",
];

const BLOG_STATUS = ["draft", "published"];

const blogSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Blog title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    slug: {
      type: String,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    excerpt: {
      type: String,
      trim: true,
      maxlength: [500, "Excerpt cannot exceed 500 characters"],
    },
    content: {
      type: String,
      required: [true, "Blog content is required"],
    },
    category: {
      type: String,
      enum: BLOG_CATEGORIES,
      default: "general",
    },
    featuredImage: {
      type: String,
      default: "",
    },
    relatedServices: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Service",
      },
    ],
    status: {
      type: String,
      enum: BLOG_STATUS,
      default: "draft",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Auto-generate slug from title before save, and ensure unique
blogSchema.pre("save", async function () {
  // Generate slug from title if not set
  if (this.isModified("title") && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 100);
  }

  // Ensure unique slug by appending random suffix if needed
  if (this.slug && (this.isModified("slug") || this.isNew)) {
    const existingBlog = await mongoose.models.Blog.findOne({
      slug: this.slug,
      _id: { $ne: this._id },
    });
    if (existingBlog) {
      this.slug = `${this.slug}-${Date.now().toString(36)}`;
    }
  }
});

// Virtual for reading time (approx 200 words per minute)
blogSchema.virtual("readingTime").get(function () {
  if (!this.content) return 1;
  const wordCount = this.content.split(/\s+/).length;
  return Math.ceil(wordCount / 200);
});

// Ensure virtuals are included in JSON output
blogSchema.set("toJSON", { virtuals: true });
blogSchema.set("toObject", { virtuals: true });

// Indexes for efficient queries
blogSchema.index({ status: 1, createdAt: -1 });
blogSchema.index({ category: 1, status: 1 });
blogSchema.index({ tags: 1 });

const Blog = mongoose.model("Blog", blogSchema);

module.exports = Blog;
module.exports.BLOG_CATEGORIES = BLOG_CATEGORIES;
module.exports.BLOG_STATUS = BLOG_STATUS;
