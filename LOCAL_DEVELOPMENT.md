# UREMO local marketplace

Keep the Git checkouts in sibling folders named `frontend` and `backend`. Use Node 22 or later and run `npm ci` in each checkout after cloning. The hosted stack is a Next.js frontend on Vercel, an Express API on Render and MongoDB Atlas. The local preview binds both servers to loopback and uses a separate database.

## Open the preview

With a local MongoDB replica named `uremoLocal` listening on `127.0.0.1:27347`, run the following from the backend folder.

```powershell
npm run preview:marketplace -- --demo
```

Open [project opportunities](http://localhost:3137/explore-services) or [admin publishing](http://localhost:3137/admin/opportunities). The API listens on port 5137. The demo option creates a synthetic worker with test credits and a synthetic editor if those accounts are missing. It prints their generated passwords when first created. Existing accounts and completed transactions keep their state when the preview restarts. Sign in again after restarting the API. Use an HTTPS sample resume link to test applications without configuring an upload provider.

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
| Create a role, set screening order and training, and publish an opportunity with the intended application, rental and buyout options. | A worker can see only the published options. A draft or private handoff is never in the public listing. |
| Open a listing in two admin tabs, save in the first and then try saving in the second. | The stale tab must prompt for a reload. Compare the stored price, status and handoff with the first save. |
| Rent from the worker profile and open Access receipts as the admin. | Match the holder, price and term. Editing future terms must not change the renter's original access. A buyout closes the listing; an admin can archive it without undoing the sale. |
| Create a role-linked project with a pay type, rate, priority and both required and optional deliverables. Return to it using the role's project link and edit the checklist. | Assign an eligible synthetic worker and reopen the worker project. The pay, ordered checklist and required markers should match the saved form. An ineligible worker must not be offered. |
| Follow the withdrawal links from the dashboard and reopen a closed support ticket to read its replies. | Wallet withdrawals and historical referral payouts have separate queues. Replying to a closed ticket leaves the status closed; reopening requires an explicit status change. |

The settlement, access and concurrency suites exercise protected API behavior independently of the browser. Run the full local regression from this directory in PowerShell:

```powershell
$env:UREMO_TEST_MONGO_PORT='27347'
$suite = @(Get-ChildItem scripts -Filter 'test-*.js' | Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'node:test' -Quiet } | ForEach-Object FullName)
node --test --test-concurrency=2 @suite
```

## Prepare existing roles

Review the specific active roles your team can offer. On a local restored copy, run `node scripts/prepare-opportunity-drafts.js --help` for the expected inputs. Preview the selected role IDs and category map before using `--write`. Imports produce application-only drafts. A publisher supplies the description, confirms project rights, and sets any rental or buyout terms before publication. The preview and importer each select a local database explicitly.
