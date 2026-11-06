/**
 * PATCH_23: Wallet Routes (User)
 * PATCH_80: Added pending topups and cancel routes
 * PATCH_82: Added PayPal top-up routes
 *
 * Endpoints for wallet balance, top-up, transactions, and payment
 */
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const walletController = require("../controllers/wallet.controller");

// All routes require authentication
router.use(authMiddleware);

// GET /api/wallet/balance - Get current wallet balance
router.get("/balance", walletController.getBalance);

// POST /api/wallet/topup - Initiate wallet top-up (PATCH_80: NO instant credit)
router.post("/topup", walletController.topUp);

// GET /api/wallet/pending - Get user's pending topup requests (PATCH_80)
router.get("/pending", walletController.getPendingTopups);

// POST /api/wallet/cancel-topup - Cancel a pending topup request (PATCH_80)
router.post("/cancel-topup", walletController.cancelTopup);

// PATCH_82: PayPal Top-Up Routes
// GET /api/wallet/topup/paypal/available - Check if PayPal is configured
router.get("/topup/paypal/available", (_req, res) => res.json({ success: true, available: false }));

// POST /api/wallet/topup/paypal/create - Create PayPal order for top-up
router.post("/topup/paypal/create", (_req, res) => res.status(410).json({ message: "New PayPal top-ups are closed. Use a manual wallet top-up request." }));

// POST /api/wallet/topup/paypal/confirm - Confirm PayPal payment after user approves
router.post("/topup/paypal/confirm", walletController.confirmPayPalTopup);

// GET /api/wallet/transactions - Get transaction history
router.get("/transactions", walletController.getTransactions);

// POST /api/wallet/pay - Pay for order using wallet
router.post("/pay", walletController.payWithWallet);

// PATCH_110: Withdrawal endpoints
// POST /api/wallet/withdraw - Request a withdrawal
router.post("/withdraw", walletController.requestWithdrawal);

// GET /api/wallet/withdrawals - Get user's withdrawal requests
router.get("/withdrawals", walletController.getMyWithdrawals);

module.exports = router;
