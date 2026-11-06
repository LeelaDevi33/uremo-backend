# UREMO local marketplace

Keep the Git checkouts in sibling folders named `frontend` and `backend`. Use Node 22 or later and run `npm ci` in each checkout after cloning. The hosted stack is a Next.js frontend on Vercel, an Express API on Render and MongoDB Atlas. The local preview binds both servers to loopback and uses a separate database.

## Open the preview

With a local MongoDB replica named `uremoLocal` listening on `127.0.0.1:27347`, run the following from the backend folder.

```powershell
npm run preview:marketplace -- --demo
```

The marketplace has three entrances: [Open Roles](http://localhost:3137/open-roles), [Rent Projects](http://localhost:3137/projects/rent) and [Full Access](http://localhost:3137/projects/full-access). The [admin project offer editor](http://localhost:3137/admin/opportunities) sets the available terms for each identified project. The API listens on port 5137. The demo creates synthetic accounts, three specialized example projects, and a sample worker qualified in accessibility testing. It prints passwords for new synthetic accounts once. Sign in again after restarting the API. Use an HTTPS sample resume link to test role applications without an upload provider.

For a full page audit, serve the optimized build. Stop the development preview first. Run these commands in PowerShell from the backend folder:

```powershell
Push-Location ../frontend
$env:NEXT_PUBLIC_API_URL='http://localhost:5137'
npm run build
Pop-Location
npm run preview:marketplace -- --demo --production
```

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
