# UREMO local marketplace

Keep the Git checkouts in sibling folders named `frontend` and `backend`. Use Node 24 LTS and run `npm ci` in each checkout after cloning. The hosted stack is a Next.js frontend on Vercel, an Express API on Render and MongoDB Atlas. The local preview binds both servers to loopback and uses a separate database.

## Open the preview

With a local MongoDB replica named `uremoLocal` listening on `127.0.0.1:27347`, run the following from the backend folder.

```powershell
npm run preview:marketplace -- --demo
```

To reopen the November admin review at the same address, use the following in the backend checkout with the local replica running:

```powershell
$env:UREMO_PREVIEW_SITE_PORT = "3157"
$env:UREMO_PREVIEW_API_PORT = "5147"
node scripts/local-marketplace.js --demo
```

Open [the local admin dashboard](http://localhost:3157/admin) and sign in using the local preview account. The default ports are 3137 and 5137. If serving an optimized build, set `NEXT_PUBLIC_API_URL` to the selected API URL when building the frontend.

The marketplace has three entrances: [Open Roles](http://localhost:3137/open-roles), [Rent Projects](http://localhost:3137/projects/rent) and [Full Access](http://localhost:3137/projects/full-access). The [admin project offer editor](http://localhost:3137/admin/opportunities) sets the available terms for each identified project. The API listens on port 5137. The demo creates synthetic accounts, three specialized example projects, and a sample worker qualified in accessibility testing. It prints passwords for new synthetic accounts once. Sign in again after restarting the API. Use an HTTPS sample resume link to test role applications without an upload provider.

For a full page audit, serve the optimized build. Stop the development preview first. Run these commands in PowerShell from the backend folder:

```powershell
Push-Location ../frontend
$env:NEXT_PUBLIC_API_URL='http://localhost:5137'
npm run build
Pop-Location
npm run preview:marketplace -- --demo --production
```

## Edit the Lumiere Life Science sample

The local `--demo` option also creates a draft named **Lumiere Life Science**. It includes a fictional seed-germination brief, two required deliverables, a private handoff, a seven-day rental at USD 15 and Full Access at USD 60. Running the demo again preserves manual edits. Its rights confirmation starts unchecked. [Open the draft in the November local preview](http://localhost:3157/admin/opportunities?edit=6af72a53dc662aac800b4e2d).

On a hosted installation, choose **Admin → Project offers → Open Lumiere sample**. The first click creates a private draft, its project and an inactive specialization in one transaction. Later clicks reopen the same offer. The hosted sample becomes available to workers only after an admin configures its role, confirms the rights and publishes the offer.

Open **Admin → Project offers**, choose Lumiere, then edit the public brief, category, access options, prices, rental duration and private handoff. **Open linked project** opens the project instructions and deliverables. **Edit specialization** opens the role and qualification settings. Save each form where you changed it. To publish real inventory, review the handoff, confirm the terms with the rights holder and publish the offer.

For a reviewed refund, open **Project offers → Access receipts**, choose the receipt and record the reason. Confirmation credits the member's wallet once, preserves the original debit and receipt, revokes the grant and archives the listing for review. Confirm both the wallet entry and the listing status after issuing a refund.

Members can find their receipt ID in **Profile → My project access**. Admins can look up that exact ID in **Access receipts** before issuing a refund. When a purchase used earnings, the refund restores the recorded earnings portion to the withdrawable balance. Receipts from before funding portions were recorded retain their original wallet-credit treatment.

## Start a fresh local replica

These commands are for a fresh development database. In PowerShell, with MongoDB Server installed, run:

```powershell
$data = Join-Path $env:LOCALAPPDATA 'UremoPlatform\marketplace-preview'
New-Item -ItemType Directory -Force -Path $data | Out-Null
mongod --dbpath "$data" --replSet uremoLocal --bind_ip 127.0.0.1 --port 27347 --wiredTigerCacheSizeGB 0.25
```

Leave that terminal running. In a second terminal in `backend`, initialize this new replica once, then start the preview:

```powershell
node -e "const m=require('mongoose'); (async()=>{await m.connect('mongodb://127.0.0.1:27347/admin?directConnection=true'); await m.connection.db.admin().command({replSetInitiate:{_id:'uremoLocal',members:[{_id:0,host:'127.0.0.1:27347'}]}});await m.disconnect()})().catch(e=>{console.error(e.message);process.exit(1)})"
npm run preview:marketplace -- --demo
```

The preview uses `uremo_market_preview`. The test suites use separate, disposable database names. Keep production credentials out of both checkouts. To run the principal marketplace regressions:

```powershell
$env:UREMO_TEST_MONGO_PORT='27347'
node --test scripts/test-opportunity-marketplace.js scripts/test-marketplace-cutover.js scripts/test-wallet-settlement.js scripts/test-prepare-opportunity-drafts.js
```

The older standalone scripts that create accounts, roles, orders or referrals require `UREMO_STAGING_API_URL` set to the loopback or staging API origin. Give the script a synthetic `TEST_EMAIL` and `TEST_PASSWORD` for member sign-in, or `ADMIN_EMAIL` and `ADMIN_PASSWORD` for admin operations. The supported replica-set suites above generate their own users.

## Check the admin and worker views before releasing

Use separate browser profiles for the local demo admin and worker. For tests that create receipts or issue credits, use a disposable local database and synthetic balances.

| In the admin | Check independently |
| --- | --- |
| Create a specialization role, set screening and training, then apply from Open Roles. | Applying is free. Approval and the required screenings establish eligibility for matching rental projects. |
| Create a project under its specialization and publish a Rent-only, Full Access-only or combined offer. | The project appears in the corresponding section(s). Any signed-in buyer can buy Full Access. Renting requires qualification in that project's specialization. |
| Open a listing in two admin tabs, save in the first and then try saving in the second. | The stale tab must prompt for a reload. Compare the stored price, status and handoff with the first save. |
| Acquire a project from a test account and reopen its profile. | The holder sees the project and the handoff from checkout. A rental ends at its expiry. Full Access transfers exclusive rights and closes the sale while the specialization continues accepting applications. Access receipts show the holder, amount and term. |
| Create a role-linked project with a pay type, rate, priority and both required and optional deliverables. Return to it using the role's project link and edit the checklist. | Assign an eligible synthetic worker and reopen the worker project. The pay, ordered checklist and required markers should match the saved form. An ineligible worker must not be offered. |
| Follow the withdrawal links from the dashboard and reopen a closed support ticket to read its replies. | Wallet withdrawals and historical referral payouts have separate queues. Replying to a closed ticket leaves the status closed; reopening requires an explicit status change. |

The settlement, access and concurrency suites exercise protected API behavior independently of the browser. Run the full local regression from this directory in PowerShell:

```powershell
$env:UREMO_TEST_MONGO_PORT='27347'
$suite = @(Get-ChildItem scripts -Filter 'test-*.js' | Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'node:test' -Quiet } | ForEach-Object FullName)
node --test --test-concurrency=2 @suite
```

## Review offers created under the previous model

On a restored local copy, run `node scripts/review-project-offers.js --db LOCAL_DATABASE --port 27347` to count offers that need review and historical receipts lacking a project association. The command reads counts only. The old role-to-offer import command is retired.

Review historical offers in Admin. For an unsettled offer, identify its actual project and save a draft before publishing new access terms. Keep settled legacy receipts and their original handoffs. Create a fresh offer for a separately verified project when appropriate. A role or a matching title alone cannot establish the identity of a purchased project. Verify the unique project-offer and exclusive-sale indexes on the restored copy before releasing.

## Rehearse backup recovery

Install MongoDB Database Tools and point the following command at the directory containing `mongodump` and `mongorestore`. The drill creates a paid exclusive sale in a fresh synthetic database, stops the source API, writes a compressed native archive, and restores it into a second fresh database. It verifies the unique offer, exclusive purchase and wallet indexes before starting the recovered API. It then replays the original request, tests a competing buyer, checks the project handoff and balances, and removes its fixtures.

```powershell
$env:UREMO_TEST_MONGO_PORT = '27347'
$env:UREMO_MONGO_TOOLS_DIR = Split-Path (Get-Command mongodump).Source
node --test scripts/test-opportunity-restore.js
```

For Atlas disaster recovery, select an available backup of the source cluster in the Atlas Backup view. Restore to a separate compatible cluster owned by this workspace. Record the snapshot time and completed restore time. Keep real customer records in this restricted recovery environment. Run read-only index and wallet reconciliation checks before directing the candidate to it. On a locally restored copy, the following commands use the local loopback interface and print aggregate results.

```powershell
node scripts/verify-marketplace-indexes.js --db RESTORED_DB --port 27347
node scripts/reconcile-wallets.js --db RESTORED_DB --port 27347
node scripts/review-project-offers.js --db RESTORED_DB --port 27347
```

The wallet audit matches each paid access receipt to its original debit. For a refunded receipt it also checks the linked refund, amount, holder and recorded earnings portion. It reports mismatches as aggregate counts.

## Host an isolated staging release

1. Create the separate `uremo_staging` database on an Atlas deployment that supports transactions. Give the staging database user access to this database only. Use synthetic accounts and project handoffs. For Atlas network rules, allow the staging Render service’s documented outbound addresses.
2. In the confirmed Render workspace, select the backend repository’s candidate branch and Blueprint path `render.staging.yaml`. Enter the staging database’s SRV connection string with `/uremo_staging` in the path and the exact HTTPS frontend staging origin as `FRONTEND_URL`. The Blueprint creates a separate free service and JWT secret, with manual subsequent deploys. Set a supported Node version for the dependency lockfile in the service configuration.
3. In Vercel, configure the Preview environment for the candidate branch (or a separate staging project's environment) before the frontend build. Set `NEXT_PUBLIC_API_URL` and `JARVISX_BACKEND_URL` to the staging API origin. Use the same staging endpoint for `NEXT_PUBLIC_SOCKET_URL` if overriding Socket.IO. Set `NEXT_PUBLIC_SITE_URL` to the staging frontend origin. Set `UREMO_ENVIRONMENT=staging` when using a standalone staging project's Production environment. Update the Render frontend origin if Vercel assigns a different stable branch URL. Rebuild the frontend after changing a public variable.
4. Record both deployed commit IDs and visit the staging frontend in Chrome. Check API and socket request destinations, then run `node scripts/test-health-contract.js https://STAGING_API_HOST`. Exercise login, role approval and screening, one rental, one exclusive purchase, and a second buyer using synthetic balances. Verify the receipts and the handoff in the buyer’s profile. If a rollout fails, return the frontend and API to the previously verified revisions. Reconcile transactions before any separate database recovery.

Render checks `/api/health/ready` for database connectivity. Set the production service’s health-check path after the compatible API has deployed there.

The API needs Node 24, a nonempty `JWT_SECRET` and a MongoDB database that accepts multi-document transactions. Startup performs a read-only transaction and verifies the unique account, checkout, withdrawal, dataset submission and payment indexes before listening. Check the service’s `NODE_VERSION` environment variable when confirming the runtime on Render. It takes precedence over the package’s `engines.node` range. [Render Node version selection](https://render.com/docs/node-version)

Set `ADMIN_EMAIL` to the comma-separated operator addresses that should receive application and order notices. A blank setting disables those notices. Configure a verified sender and `RESEND_API_KEY` before testing email delivery to a controlled inbox.

## Operate wallet funding

In **Admin → Payments → Wallet funding methods**, choose **Add funding method**. Enter the method name, receiving details and transfer instructions, then activate it when the receiving account is ready. For a manual method such as Binance Pay, specify the supported transfer type, currency, receiving identifier and which transaction ID the sender should enter. Inactive methods disappear from the worker's wallet. An admin can continue reviewing requests that were submitted while the method was active.

A worker chooses the method in **Wallet → Add Balance** and submits the USD amount and transfer reference. In **Admin → Wallet**, match the amount, recipient and reference against the receiving account's settled transaction. Approve with the matching reference or reject the request with a reason. The successful credit records the operator and reference. The same settlement reference can fund only one wallet. Wallet funding is a deposit. Project purchase and rental receipts record marketplace revenue.

PayPal is the supported automatic wallet gateway. The admin page shows its configuration and activation state. Keep the client secret in the backend's environment settings.

1. In the appropriate PayPal developer app, register the HTTPS webhook URL `https://YOUR_API_HOST/api/wallet/topup/paypal/webhook`. Subscribe it to `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`.
2. Set `PAYPAL_MODE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` (the receiving merchant) and `PAYPAL_WEBHOOK_ID` on the backend. Set `FRONTEND_URL` to the exact frontend origin for checkout returns. Use sandbox credentials and `PAYPAL_MODE=sandbox` with `UREMO_ENVIRONMENT=staging`. A production API uses `PAYPAL_MODE=live` and the corresponding live credentials.
3. Restart the API, open **Admin → Payments**, and enable PayPal. A complete configuration starts paused. The pause control stops new orders and lets previously approved payments settle. Check an actual sandbox payment from the worker wallet before enabling a live account. Verify that both the worker's return and a redelivered webhook yield a single credit.

The API verifies the webhook signature with PayPal and reads the order directly to validate its merchant, wallet transaction, settled USD amount and completed capture. Manual review cannot approve a PayPal transaction. A project refund is a separate admin action on its access receipt. It credits the worker's wallet, revokes project access and leaves the project closed for review.

### Check historical manual funding before rollout

The new partial unique index covers a user's open manual requests with the same method and normalized payment reference. Older amount-only requests without a payment reference fall outside this index and remain reviewable. The API waits for the marketplace indexes before accepting traffic. A conflicting existing record or index stops startup and leaves the original data in place. Use a restored copy to identify duplicate groups with this read-only query. It returns counts without exposing payment references.

```javascript
db.wallettransactions.aggregate([
  { $match: { provider: "manual", paymentReference: { $type: "string" }, status: { $in: ["initiated", "pending"] } } },
  { $group: { _id: { user: "$user", methodId: "$methodId", ref: "$paymentReference" }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } },
  { $count: "duplicatePendingGroups" }
])
```

Review any matches against their original payment evidence. Reject duplicate requests individually through the previous admin release, preserving their history and the legitimate transfer. Verify the indexes and reconcile wallets on the restored copy before rollout.

Historical PayPal orders must also identify a single wallet request. Check for duplicate order references on a restored copy before starting the candidate. Resolve ambiguous ownership against the provider’s settlement records. Keep both original ledger records until the reconciliation is reviewed.

```javascript
db.wallettransactions.aggregate([
  { $match: { provider: "paypal", source: "topup", providerRef: { $type: "string" } } },
  { $group: { _id: "$providerRef", count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } },
  { $count: "duplicatePayPalOrderGroups" }
])
```
