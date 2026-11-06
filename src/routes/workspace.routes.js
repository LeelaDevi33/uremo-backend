/**
 * PATCH_38/43/47/48: Workspace Routes
 * Worker flow endpoints: profile, screenings, projects, earnings, proofs
 * PATCH_43: Multi-job support, apply to specific jobs
 * PATCH_47: Start project endpoint
 * PATCH_48: Proof of work submission
 */
const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");

const {
  getWorkspaceProfile,
  applyToJob,
  getAvailableScreenings,
  getScreening,
  submitScreening,
  getMyProjects,
  getProject,
  startProject,
  submitProject,
  getEarnings,
  requestWithdrawal,
  markTrainingViewed, // PATCH_49
} = require("../controllers/workspace.controller");

// PATCH_48: Proof of work
const {
  submitProof,
  getProjectProof,
  getMyProofs,
} = require("../controllers/proof.controller");

// PATCH_95: RLHF task execution
const {
  workerGetProjectTasks,
  workerSubmitTask,
} = require("../controllers/dataset.controller");

// All routes require authentication
router.use(auth);

// Worker profile & status (multi-job)
router.get("/profile", getWorkspaceProfile);

// PATCH_43: Apply to a specific job role
router.post("/apply/:jobId", applyToJob);

// PATCH_49: Mark training as viewed for an application
router.put("/application/:appId/mark-training-viewed", markTrainingViewed);

// Screenings
router.get("/screenings", getAvailableScreenings);
router.get("/screening/:id", getScreening);
router.post("/screening/:id/submit", submitScreening);

// Projects
router.get("/projects", getMyProjects);
router.get("/project/:id", getProject);
router.use("/project/:id", require("../services/profileProjects").workAssignmentsOnly);
router.post("/project/:id/start", startProject);
router.post("/project/:id/submit", submitProject);

// PATCH_48: Proof of work
router.get("/my-proofs", getMyProofs);
router.get("/project/:id/proof", getProjectProof);
router.post("/project/:id/proof", submitProof);

// PATCH_95: RLHF task execution
router.get("/project/:id/rlhf-tasks", workerGetProjectTasks);
router.post("/project/:id/rlhf-submit", workerSubmitTask);

// Earnings
router.get("/earnings", getEarnings);
router.post("/withdraw", requestWithdrawal);

module.exports = router;
