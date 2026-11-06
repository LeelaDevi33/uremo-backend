/*
  Lightweight backend smoke tests.

  Goals:
  - Make `npm test` meaningful (non-zero on failure)
  - Work in local dev (localhost) and also when only prod is reachable
  - Avoid hardcoding credentials in the repo

  Usage:
    npm test
    node scripts/test-runner.js --base=https://uremo-backend.onrender.com
    node scripts/test-runner.js --auth   (requires TEST_EMAIL + TEST_PASSWORD)

  Env:
    UREMO_API_BASE / BASE_URL: override base URL
    TEST_EMAIL, TEST_PASSWORD: enable auth check when using --auth
*/

const DEFAULT_CANDIDATES = [
  "http://localhost:5000",
];

function isInteractiveTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function promptLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      chunks.push(String(data));
      resolve(chunks.join("").trim());
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    // Some VS Code terminals don't handle stdin raw-mode reliably.
    // Use readline + a Writable that conditionally mutes output.
    const readline = require("readline");
    const { Writable } = require("stream");

    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });

    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      resolve(String(answer || ""));
    });

    // After printing the prompt, mute subsequent keystrokes.
    muted = true;
  });
}

function parseArgs(argv) {
  const out = { base: null, auth: false, email: null, password: null };
  for (const raw of argv.slice(2)) {
    if (raw === "--auth") out.auth = true;
    else if (raw.startsWith("--base=")) out.base = raw.slice("--base=".length);
    else if (raw.startsWith("--email="))
      out.email = raw.slice("--email=".length);
    else if (raw.startsWith("--password="))
      out.password = raw.slice("--password=".length);
  }
  return out;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timeoutId),
  );
}

async function fetchJson(url, init, timeoutMs = 8000) {
  const res = await withTimeout(fetch(url, init), timeoutMs, `fetch ${url}`);
  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const text = await res.text();
  let body = text;
  if (isJson) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { res, body, text };
}

async function canReach(base) {
  try {
    const { res, body } = await fetchJson(
      `${base.replace(/\/+$/, "")}/api/health`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      2500,
    );

    return res.ok && typeof body === "object";
  } catch {
    return false;
  }
}

async function resolveBaseUrl(cliBase) {
  const envBase = (
    process.env.UREMO_API_BASE ||
    process.env.BASE_URL ||
    ""
  ).trim();
  const preferred = (cliBase || envBase || "").trim();

  if (preferred) {
    return preferred.replace(/\/+$/, "");
  }

  for (const candidate of DEFAULT_CANDIDATES) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canReach(candidate);
    if (ok) return candidate;
  }

  // Fall back to localhost (common dev default) so error messages are consistent.
  return "http://localhost:5000";
}

function fail(message, extra) {
  console.error(`\n❌ ${message}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✅ ${message}`);
}

async function testHealth(base) {
  const { res, body, text } = await fetchJson(
    `${base}/api/health`,
    { method: "GET" },
    8000,
  );
  if (!res.ok) {
    fail(`/api/health returned HTTP ${res.status}`, text);
    return;
  }
  if (!body || typeof body !== "object") {
    fail(`/api/health did not return JSON`, text);
    return;
  }
  pass("/api/health reachable");
}

async function testOpportunities(base) {
  const roles = await fetchJson(base + "/api/work-positions", { method: "GET" }, 12000);
  if (!roles.res.ok || !Array.isArray(roles.body)) return fail("Open role catalog returned an unexpected response", roles.res.status);
  if (roles.body.some(role => role.rentEnabled || role.buyEnabled || role.rentPrice || role.buyPrice)) {
    return fail("An open specialization role exposes commercial terms");
  }
  pass(`Open specialization roles reachable (${roles.body.length} roles)`);
  const { res, body } = await fetchJson(base + "/api/opportunities", { method: "GET" }, 12000);
  if (!res.ok || body?.ok !== true || !Array.isArray(body.opportunities)) {
    fail("Opportunity catalog returned an unexpected response", res.status);
    return;
  }
  const invalid = body.opportunities.some(offer =>
    offer.kind !== "project" || !offer.projectId || !offer.workPositionId || offer.applyEnabled !== false ||
    (!offer.rentEnabled && !offer.buyEnabled) || Object.hasOwn(offer, "deliverable"),
  );
  if (invalid) return fail("The public paid catalog includes a mixed offer, missing project, or private handoff");
  pass(`Public project offers reachable (${body.opportunities.length} offers)`);
}

async function testAuthOrdersMy(base, creds) {
  let email = String(creds?.email || process.env.TEST_EMAIL || "").trim();
  let password = String(creds?.password || process.env.TEST_PASSWORD || "");

  if ((!email || !password) && isInteractiveTty()) {
    if (!email) {
      // eslint-disable-next-line no-await-in-loop
      email = String((await promptLine("Enter admin email: ")) || "").trim();
    }
    if (!password) {
      // eslint-disable-next-line no-await-in-loop
      password = String((await promptHidden("Enter admin password: ")) || "");
    }
  }

  if (!email || !password) {
    fail(
      "--auth requires credentials via --email/--password or TEST_EMAIL/TEST_PASSWORD env vars",
    );
    return;
  }

  const loginPayload = JSON.stringify({ email, password });
  const {
    res: loginRes,
    body: loginBody,
    text: loginText,
  } = await fetchJson(
    `${base}/api/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: loginPayload,
    },
    12000,
  );

  if (!loginRes.ok) {
    fail(`/api/auth/login returned HTTP ${loginRes.status}`, loginText);
    return;
  }

  const token =
    typeof loginBody === "object" && loginBody ? loginBody.token : null;
  if (!token || typeof token !== "string") {
    fail("Login response missing token", loginText);
    return;
  }

  const {
    res: ordersRes,
    body: ordersBody,
    text: ordersText,
  } = await fetchJson(
    `${base}/api/orders/my`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
    12000,
  );

  if (!ordersRes.ok) {
    fail(`/api/orders/my returned HTTP ${ordersRes.status}`, ordersText);
    return;
  }

  if (!Array.isArray(ordersBody)) {
    fail("/api/orders/my expected JSON array", ordersText);
    return;
  }

  pass(`/api/orders/my ok (${ordersBody.length} orders)`);

  const { res, body } = await fetchJson(base + "/api/opportunities/mine", {
    method: "GET", headers: { Authorization: "Bearer " + token },
  }, 12000);
  if (!res.ok || !Array.isArray(body?.grants)) return fail("My project access returned an unexpected response", res.status);
  pass(`My project access ok (${body.grants.length} grants)`);
}

async function main() {
  const args = parseArgs(process.argv);
  const base = await resolveBaseUrl(args.base);
  const normalizedBase = base.replace(/\/+$/, "");

  console.log(`\nUREMO backend smoke tests`);
  console.log(`Base: ${normalizedBase}`);

  // If base isn't reachable, fail fast with a clear message.
  const reachable = await canReach(normalizedBase);
  if (!reachable) {
    fail(
      `Backend not reachable at ${normalizedBase}. Set UREMO_API_BASE or run the server locally.`,
      `Tried: ${DEFAULT_CANDIDATES.join(", ")}`,
    );
    return;
  }

  await testHealth(normalizedBase);
  await testOpportunities(normalizedBase);

  if (args.auth) {
    await testAuthOrdersMy(normalizedBase, {
      email: args.email,
      password: args.password,
    });
  } else {
    console.log(
      "ℹ️  Auth test skipped (run with --auth + TEST_EMAIL/TEST_PASSWORD). ",
    );
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.log("\nSome tests failed.");
  } else {
    console.log("\nAll tests passed.");
  }
}

main().catch((err) => {
  fail("Unhandled test runner error", err?.stack || String(err));
});
