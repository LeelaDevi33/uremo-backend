# UREMO Platform Architecture

This is the June 2025 architecture record. The current marketplace separates free specialization applications from individual project rentals and exclusive purchases. See [the current marketplace workflow and release checks](LOCAL_DEVELOPMENT.md#check-the-admin-and-worker-views-before-releasing).

> **Version:** 1.0  
> **Last Updated:** June 2025  
> **Status:** Production Ready (Post-PATCH_27)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [Architecture Diagram](#architecture-diagram)
4. [Backend Architecture](#backend-architecture)
5. [Frontend Architecture](#frontend-architecture)
6. [Database Models](#database-models)
7. [API Groups](#api-groups)
8. [Core Flows](#core-flows)
9. [Authentication & Authorization](#authentication--authorization)
10. [Real-time Features](#real-time-features)
11. [File Upload System](#file-upload-system)
12. [Payment System](#payment-system)
13. [Admin Permissions](#admin-permissions)
14. [Security Design](#security-design)
15. [Deployment](#deployment)
16. [Known Limitations](#known-limitations)
17. [Future Roadmap](#future-roadmap)

---

## System Overview

UREMO is a full-stack service marketplace platform that connects service providers with customers. The platform supports:

- **Service Orders** — Users browse and order digital services
- **Rental System** — Timed subscription-based product rentals
- **Wallet System** — Internal balance for payments and refunds
- **Affiliate Program** — Referral-based commission earning
- **Ticketing System** — Customer support with file attachments
- **Blog/CMS** — Admin-managed content publishing
- **Real-time Chat** — Socket.io-based order communication

---

## Technology Stack

### Backend

| Component     | Technology         | Version |
| ------------- | ------------------ | ------- |
| Runtime       | Node.js            | 18+     |
| Framework     | Express.js         | 5.2.1   |
| Database      | MongoDB            | Atlas   |
| ODM           | Mongoose           | 9.1.1   |
| Auth          | JWT + bcryptjs     | —       |
| File Storage  | Cloudinary         | v2      |
| File Upload   | Multer             | —       |
| Email         | Resend API         | —       |
| Payments      | Stripe SDK         | —       |
| Rate Limiting | express-rate-limit | —       |
| Real-time     | Socket.io          | 4.x     |

### Frontend

| Component   | Technology                    | Version          |
| ----------- | ----------------------------- | ---------------- |
| Framework   | Next.js                       | 13+ (App Router) |
| Language    | TypeScript                    | 5.x              |
| Styling     | Tailwind CSS                  | 3.x              |
| Animations  | Framer Motion                 | —                |
| Real-time   | Socket.io-client              | —                |
| HTTP Client | Fetch API (custom apiRequest) | —                |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         UREMO PLATFORM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐          ┌──────────────────────────────┐│
│  │   FRONTEND       │          │         BACKEND               ││
│  │   (Next.js)      │──HTTPS──▶│         (Express.js)          ││
│  │                  │          │                               ││
│  │  Vercel alias    │          │  uremo-backend.onrender.com   ││
│  └──────────────────┘          └──────────────────────────────┘│
│                                          │                      │
│                                          ▼                      │
│         ┌────────────────────────────────────────────┐         │
│         │              MONGODB ATLAS                  │         │
│         │                                            │         │
│         │  Collections:                              │         │
│         │  - users, orders, services, rentals        │         │
│         │  - tickets, ticketmessages, ordermessages  │         │
│         │  - wallettransactions, affiliatewithdrawals│         │
│         │  - blogs, paymentmethods, sitesettings     │         │
│         └────────────────────────────────────────────┘         │
│                                          │                      │
│              ┌───────────────────────────┼─────────────────┐    │
│              │                           │                 │    │
│              ▼                           ▼                 ▼    │
│  ┌──────────────────┐   ┌──────────────────┐  ┌───────────────┐│
│  │   CLOUDINARY     │   │     RESEND       │  │    STRIPE     ││
│  │   (File Storage) │   │     (Email)      │  │   (Payments)  ││
│  └──────────────────┘   └──────────────────┘  └───────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Backend Architecture

### Directory Structure

```
uremo-backend/src/
├── app.js              # Express app config (CORS, routes)
├── server.js           # Entry point (DB connect, Socket.io)
├── config/
│   ├── db.js           # MongoDB connection
│   ├── cloudinary.js   # Cloudinary config
│   └── stripe.js       # Stripe config
├── controllers/        # Business logic (32 files)
├── models/             # Mongoose schemas (24 files)
├── routes/             # API endpoints (32 files)
├── middlewares/
│   ├── auth.middleware.js      # JWT verification
│   ├── admin.middleware.js     # Admin role check
│   ├── authOptional.middleware.js
│   └── upload.middleware.js    # Multer config
├── services/
│   └── affiliateCommission.service.js
└── utils/
    └── email.js        # Resend integration
```

### Route Mounting (app.js)

```javascript
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/affiliate", affiliateRoutes);
app.use("/api/rentals", rentalRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/blogs", blogRoutes);
app.use("/api/payment-methods", paymentMethodRoutes);
app.use("/api/admin", adminRoutes);
// ... and more
```

---

## Frontend Architecture

### Directory Structure

```
uremo-frontend/
├── app/                    # Next.js 13+ App Router
│   ├── (auth)/             # Route group for auth pages
│   │   ├── login/
│   │   └── signup/
│   ├── orders/             # User order list & details
│   ├── wallet/             # Wallet balance & transactions
│   ├── affiliate/          # Affiliate dashboard
│   ├── rentals/            # Rental management
│   ├── support/            # Ticket system
│   ├── admin/              # Admin dashboard
│   │   ├── orders/
│   │   ├── services/
│   │   ├── users/
│   │   ├── wallet/
│   │   ├── affiliates/
│   │   ├── tickets/
│   │   └── settings/
│   └── layout.tsx          # Root layout with providers
├── components/             # Shared UI components
├── hooks/                  # Custom React hooks
├── lib/
│   ├── api.ts              # apiRequest helper
│   └── socket.ts           # Socket.io client
└── public/                 # Static assets
```

### Key Patterns

1. **Server Components** — Data fetching on server where possible
2. **Client Components** — `"use client"` for interactivity
3. **API Helper** — Centralized `apiRequest()` with auth token injection
4. **Custom Hooks** — `useToast()`, `useSiteSettings()`, `useAuth()`

---

## Database Models

### Core Models (24 Total)

| Model                    | Purpose              | Key Fields                                                                       |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| **User**                 | User accounts        | email, password, role, walletBalance, affiliateBalance, referralCode, referredBy |
| **Order**                | Service orders       | userId, serviceId, status, payment, timeline, statusLog                          |
| **Service**              | Available services   | title, description, price, category, isActive                                    |
| **Rental**               | Subscription rentals | userId, serviceId, status, startDate, endDate, renewalCount                      |
| **WalletTransaction**    | Wallet history       | user, type (credit/debit), amount, source, referenceId                           |
| **AffiliateTransaction** | Commission records   | user, referredUser, order, commission, status                                    |
| **AffiliateWithdrawal**  | Payout requests      | user, amount, paymentMethod, paymentDetails, status                              |
| **Ticket**               | Support tickets      | user, subject, status, priority                                                  |
| **TicketMessage**        | Ticket messages      | ticketId, sender, message, attachments                                           |
| **OrderMessage**         | Order chat           | orderId, sender, message, attachments                                            |
| **Blog**                 | Blog posts           | title, slug, content, author, isPublished                                        |
| **PaymentMethod**        | Payment options      | name, type, details, instructions, isActive                                      |
| **SiteSettings**         | UI configuration     | key, value (JSON)                                                                |

### Order Status Flow

```
pending → payment_pending → payment_submitted → review → processing
       → pending_review → assistance_required → approved → completed
                                                        ↘ rejected
```

### Rental Status Flow

```
pending → active → expired
                 ↘ cancelled
                 ↗ renewed (loops to active)
```

---

## API Groups

### Public APIs (No Auth)

| Method | Endpoint           | Purpose           |
| ------ | ------------------ | ----------------- |
| POST   | /api/auth/signup   | User registration |
| POST   | /api/auth/login    | User login        |
| GET    | /api/services      | List services     |
| GET    | /api/services/:id  | Service details   |
| GET    | /api/blogs         | List blogs        |
| GET    | /api/site-settings | Get UI config     |

### Protected APIs (Auth Required)

| Method | Endpoint                 | Purpose              |
| ------ | ------------------------ | -------------------- |
| GET    | /api/auth/me             | Current user profile |
| GET    | /api/orders/my           | User's orders        |
| POST   | /api/orders              | Create order         |
| GET    | /api/wallet/balance      | Wallet balance       |
| GET    | /api/wallet/transactions | Transaction history  |
| POST   | /api/wallet/pay          | Pay with wallet      |
| GET    | /api/affiliate/stats     | Affiliate dashboard  |
| POST   | /api/affiliate/withdraw  | Request withdrawal   |
| GET    | /api/tickets             | User's tickets       |
| POST   | /api/tickets             | Create ticket        |

### Admin APIs (Admin Role Required)

| Method | Endpoint                              | Purpose             |
| ------ | ------------------------------------- | ------------------- |
| GET    | /api/admin/orders                     | All orders          |
| PUT    | /api/admin/orders/:id                 | Update order status |
| GET    | /api/admin/users                      | All users           |
| PUT    | /api/admin/users/:id/role             | Change user role    |
| GET    | /api/admin/wallet                     | All transactions    |
| PUT    | /api/admin/wallet/top-up              | Add to user balance |
| GET    | /api/admin/affiliates/withdrawals     | Withdrawal requests |
| PUT    | /api/admin/affiliates/withdrawals/:id | Approve/reject      |
| GET    | /api/admin/tickets                    | All tickets         |
| PUT    | /api/admin/tickets/:id                | Update ticket       |

---

## Core Flows

### 1. Order Flow

```
[User] browses /services
   │
   ▼
[User] clicks "Order Now" → POST /api/orders
   │
   ▼
[Backend] creates order with status: "payment_pending"
   │
   ▼
[User] submits payment proof → PUT /api/orders/:id/submit-payment
   │
   ▼
[Admin] reviews proof → PUT /api/admin/orders/:id/verify-payment
   │
   ▼
[Backend] sets status: "processing"
   │
   ▼
[Admin] works on order, updates timeline
   │
   ▼
[Admin] marks status: "completed"
```

### 2. Wallet Flow

```
[Admin] adds funds → POST /api/admin/wallet/top-up
   │
   ▼
[Backend] creates WalletTransaction (credit), updates user.walletBalance
   │
   ▼
[User] pays for order → POST /api/wallet/pay
   │
   ▼
[Backend] ATOMIC deduction (findOneAndUpdate with $inc)
   │
   ▼
[Backend] creates WalletTransaction (debit)
```

### 3. Affiliate Flow

```
[User A] signs up with referral code of [User B]
   │
   ▼
[User A] places order and pays
   │
   ▼
[Backend] calculates 10% commission → AffiliateTransaction
   │
   ▼
[User B].affiliateBalance += commission
   │
   ▼
[User B] requests withdrawal → POST /api/affiliate/withdraw
   │
   ▼
[Backend] ATOMIC deduction (findOneAndUpdate with $inc)
   │
   ▼
[Admin] approves → PUT /api/admin/affiliates/withdrawals/:id
```

### 4. Rental Flow

```
[User] orders rental service → POST /api/orders
   │
   ▼
[Admin] approves → Backend creates Rental (status: "active")
   │
   ▼
[Cron job] checks expirations daily
   │
   ▼
[User] renews rental → POST /api/rentals/:id/renew
   │
   ▼
[Backend] extends endDate, increments renewalCount
```

---

## Authentication & Authorization

### JWT Token Flow

```
1. User logs in → POST /api/auth/login
2. Backend verifies password (bcrypt.compare)
3. Backend issues JWT: { id, email, role }
4. Frontend stores token in localStorage
5. All requests include: Authorization: Bearer <token>
```

### Middleware Chain

```javascript
// Protected route
router.get("/orders/my", authMiddleware, orderController.getMyOrders);

// Admin route
router.get(
  "/admin/orders",
  authMiddleware,
  adminMiddleware,
  adminController.getOrders,
);
```

### Auth Middleware Logic

```javascript
// auth.middleware.js
const token = req.headers.authorization?.split(" ")[1];
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = { id: decoded.id, role: decoded.role };
next();
```

### Admin Middleware Logic

```javascript
// admin.middleware.js
// Re-fetches user from DB to prevent stale role claims
const user = await User.findById(req.user.id).select("role").lean();
if (user.role !== "admin")
  return res.status(403).json({ message: "Admin access required" });
```

---

## Real-time Features

### Socket.io Integration

**Server Setup (server.js):**

```javascript
const io = require("socket.io")(server, {
  cors: { origin: checkCorsOrigin, credentials: true },
  allowRequest: (req, done) => done(null, isAllowedOrigin(req.headers.origin)),
});

io.use(socketAuthMiddleware);

io.on("connection", (socket) => {
  socket.on("join-order", (orderId) => socket.join(`order:${orderId}`));
  socket.on("order-message", (data) => {
    io.to(`order:${data.orderId}`).emit("new-message", data);
  });
});
```

**Client Usage (lib/socket.ts):**

```typescript
const socket = io(BACKEND_URL, { auth: { token } });
socket.emit("join-order", orderId);
socket.on("new-message", (msg) => setMessages((prev) => [...prev, msg]));
```

### SSE for Streaming (Alternative)

```javascript
// For clients that can't use WebSocket
router.get("/messages/stream", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  // Stream messages...
});
```

---

## File Upload System

### Architecture

```
┌──────────┐     ┌─────────────┐     ┌─────────────┐
│  Client  │────▶│   Multer    │────▶│  Cloudinary │
│  (form)  │     │  (memoryStorage) │  (cloud)    │
└──────────┘     └─────────────┘     └─────────────┘
```

### Upload Middleware

```javascript
// upload.middleware.js
const multer = require("multer");
const cloudinary = require("../config/cloudinary");

const upload = multer({ storage: multer.memoryStorage() });

// Usage in routes
router.post(
  "/upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    const result = await cloudinary.uploader.upload_stream(req.file.buffer);
    res.json({ url: result.secure_url });
  },
);
```

### Supported File Types

- **Images:** jpg, jpeg, png, gif, webp
- **Documents:** pdf
- **Max Size:** 10MB (configurable)

---

## Payment System

### Payment Methods

| Type   | Description                             |
| ------ | --------------------------------------- |
| Manual | User uploads payment proof (screenshot) |
| Wallet | Deduct from internal wallet balance     |
| Stripe | (Future) Direct card payments           |

### Manual Payment Flow

```
1. User selects payment method (bank, crypto, etc.)
2. User sends payment externally
3. User uploads proof screenshot
4. Admin verifies and approves
```

### Wallet Payment Flow

```
1. User has sufficient walletBalance
2. POST /api/wallet/pay with orderId
3. Backend atomically deducts balance
4. Order moves to "processing"
```

---

## Admin Permissions

### Role-Based Access

| Resource            | User | Admin |
| ------------------- | ---- | ----- |
| View own orders     | ✅   | ✅    |
| View all orders     | ❌   | ✅    |
| Update order status | ❌   | ✅    |
| Manage services     | ❌   | ✅    |
| View all users      | ❌   | ✅    |
| Change user roles   | ❌   | ✅    |
| Top-up wallets      | ❌   | ✅    |
| Approve withdrawals | ❌   | ✅    |
| Manage tickets      | ❌   | ✅    |
| Manage blogs        | ❌   | ✅    |
| Site settings       | ❌   | ✅    |

### Admin Dashboard Sections

- `/admin/orders` — Manage all orders
- `/admin/services` — CRUD services
- `/admin/users` — User management
- `/admin/wallet` — Transactions & top-ups
- `/admin/affiliates` — Withdrawal approvals
- `/admin/tickets` — Support tickets
- `/admin/blogs` — Content management
- `/admin/settings` — Site configuration

---

## Security Design

### Implemented Measures

| Area               | Implementation                       |
| ------------------ | ------------------------------------ |
| Password Storage   | bcrypt with salt rounds              |
| Token Auth         | JWT with secret key                  |
| CORS               | Restricted to frontend origins       |
| Rate Limiting      | express-rate-limit on auth routes    |
| Input Validation   | Mongoose schema validation           |
| XSS Prevention     | Response sanitization                |
| Admin Verification | DB role check (not just JWT claim)   |
| Atomic Operations  | findOneAndUpdate for balance changes |

### Security Headers

```javascript
app.use(
  cors({
    origin: checkCorsOrigin, // Shared with Socket.IO in src/config/browserOrigins.js
    credentials: true,
  }),
);
```

### Atomic Balance Updates (PATCH_27)

```javascript
// Prevents race conditions
const result = await User.findOneAndUpdate(
  { _id: userId, walletBalance: { $gte: amount } },
  { $inc: { walletBalance: -amount } },
  { new: true },
);
if (!result) return res.status(400).json({ error: "Insufficient balance" });
```

---

## Deployment

### Production URLs

| Service  | URL                                |
| -------- | ---------------------------------- |
| Frontend | https://uremo-frontend.vercel.app  |
| Backend  | https://uremo-backend.onrender.com |
| Database | MongoDB Atlas                      |

### Environment Variables

**Backend (.env):**

```
PORT=5000
MONGO_URI=mongodb+srv://...
JWT_SECRET=<secure-random-string>
CLOUDINARY_NAME=<account>
CLOUDINARY_API_KEY=<key>
CLOUDINARY_API_SECRET=<secret>
STRIPE_SECRET_KEY=<key>
RESEND_API_KEY=<key>
FRONTEND_URL=https://uremo-frontend.vercel.app
# Optional comma-separated list of additional exact frontend origins, e.g. a staging URL.
CORS_ALLOWED_ORIGINS=
```

**Frontend (.env.local):**

```
NEXT_PUBLIC_API_URL=https://uremo-backend.onrender.com
```

### Deployment Platforms

- **Frontend:** Vercel (recommended) or similar
- **Backend:** Render.com
- **Database:** MongoDB Atlas (free tier available)

---

## Known Limitations

### Current Constraints

1. **No Test Suite** — `npm test` not configured
2. **No Swagger/OpenAPI** — API documentation is manual
3. **No Structured Logging** — Console.log only
4. **No Background Jobs** — Cron runs on server process
5. **No WebSocket Scaling** — Single server only
6. **No CDN** — Cloudinary serves as CDN for uploads
7. **No Search Indexing** — MongoDB text search only

### Technical Debt

- [ ] Add Jest/Vitest testing
- [ ] Add Winston/Pino logging
- [ ] Add OpenAPI/Swagger docs
- [ ] Add Redis for sessions/caching
- [ ] Add BullMQ for background jobs

---

## Future Roadmap

### Phase 1: Stability (Current)

- ✅ Complete all core flows
- ✅ Fix race conditions
- ✅ Add file attachments to tickets/chat
- ✅ Complete status colors in UI

### Phase 2: Enhanced Payments

- [ ] Stripe direct integration
- [ ] Cryptocurrency payments
- [ ] Automatic payment detection

### Phase 3: Scalability

- [ ] Redis caching layer
- [ ] Socket.io-redis adapter
- [ ] CDN for static assets
- [ ] Load balancer ready

### Phase 4: Features

- [ ] Multi-language support
- [ ] Push notifications
- [ ] Mobile app (React Native)
- [ ] Seller dashboard (multi-vendor)

### Phase 5: Analytics

- [ ] Admin analytics dashboard
- [ ] Revenue reports
- [ ] User engagement metrics
- [ ] Affiliate performance tracking

---

## Appendix: Quick Reference

### Common Commands

```bash
# Backend development
cd uremo-backend
npm install
npm run dev  # or nodemon src/server.js

# Frontend development
cd uremo-frontend
npm install
npm run dev

# Build frontend
npm run build
```

### API Testing

```bash
# Login
curl -X POST https://uremo-backend.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'

# Get orders (with token)
curl https://uremo-backend.onrender.com/api/orders/my \
  -H "Authorization: Bearer <token>"
```

### MongoDB Queries

```javascript
// Find pending orders
db.orders.find({ status: "payment_pending" });

// Get user with affiliate stats
db.users.findOne(
  { email: "user@example.com" },
  {
    walletBalance: 1,
    affiliateBalance: 1,
    referralCode: 1,
  },
);

// Count orders by status
db.orders.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
```

---

_Document generated as part of UREMO Platform System Audit (PATCH_27)_
