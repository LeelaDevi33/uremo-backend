const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");
const retiredCatalog = require("../middlewares/retiredCatalog");

// Bookmarked clients used this action to publish legacy service listings.
router.post("/execute", auth, admin, retiredCatalog);

module.exports = router;
