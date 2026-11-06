/**
 * PATCH_22: Rental Routes (User-facing)
 */

const express = require("express");
const retiredCatalog = require("../middlewares/retiredCatalog");
const auth = require("../middlewares/auth.middleware");
const {
  getUserRentals,
  getRentalById,
  cancelRental,
} = require("../controllers/rentals.controller");

const router = express.Router();

// Get all rental services (public)
router.get("/", retiredCatalog);

// Create rental order (requires auth)
router.post("/create", auth, retiredCatalog);

// Get user's rentals
router.get("/my", auth, getUserRentals);

// Get single rental by ID
router.get("/:id", auth, getRentalById);

// Cancel rental
router.put("/:id/cancel", auth, cancelRental);

// Renew rental
router.post("/:id/renew", auth, retiredCatalog);

module.exports = router;
