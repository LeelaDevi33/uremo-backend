/**
 * PATCH_23: Admin Wallet Routes
 * PATCH_80: Added pending topups verification routes
 *
 * Admin endpoints for managing user wallets
 */
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const walletController = require("../controllers/wallet.controller");

// All routes require authentication + admin
router.use(authMiddleware);
router.use(adminMiddleware);

// GET /api/admin/wallet/stats - Get wallet statistics
router.get("/stats", walletController.adminGetStats);

// PATCH_80: GET /api/admin/wallet/pending-topups - Get all pending topup requests
router.get("/pending-topups", walletController.adminGetPendingTopups);

// PATCH_80: POST /api/admin/wallet/verify-topup - Verify (approve/reject) a topup
router.post("/verify-topup", walletController.adminVerifyTopup);

// GET /api/admin/wallet/users - List all users with wallet balance (paginated with filters)
router.get("/users", walletController.adminListUsers);

// GET /api/admin/wallet/search - Search users
router.get("/search", walletController.adminSearchUsers);

// GET /api/admin/wallet/user/:userId - Get user wallet details
router.get("/user/:userId", walletController.adminGetUserWallet);

// POST /api/admin/wallet/adjust - Adjust user balance
router.post("/adjust", walletController.adminAdjustBalance);
router.post("/adjust/:id/undo", walletController.adminUndoAdjustment);

// PATCH_110: Withdrawal management
// GET /api/admin/wallet/withdrawals - List all withdrawal requests
router.get("/withdrawals", walletController.adminGetWithdrawals);

// PUT /api/admin/wallet/withdrawals/:id/approve - Approve withdrawal
router.put("/withdrawals/:id/approve", walletController.adminApproveWithdrawal);

// PUT /api/admin/wallet/withdrawals/:id/pay - Mark withdrawal as paid
router.put("/withdrawals/:id/pay", walletController.adminMarkWithdrawalPaid);

// PUT /api/admin/wallet/withdrawals/:id/reject - Reject withdrawal
router.put("/withdrawals/:id/reject", walletController.adminRejectWithdrawal);

// PATCH_110: Finance dashboard
// GET /api/admin/wallet/finance - Get finance metrics derived from ledger
router.get("/finance", walletController.adminGetFinanceMetrics);

module.exports = router;
