const router = require("express").Router();

const auth = require("../middlewares/auth.middleware");
const retiredCatalog = require("../middlewares/retiredCatalog");
const ServiceRequestController = require("../controllers/serviceRequest.controller");

// Public create (optional auth; attach token if available in client)
router.post("/", retiredCatalog);

// Auth-only: list current user's requests
router.get("/my", auth, ServiceRequestController.getMyServiceRequests);

module.exports = router;
