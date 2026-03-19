#!/usr/bin/env node
/**
 * Integration test for the Google credentials feature.
 *
 * Requires:
 *   1. Local Postgres running (postgres://postgres:postgres@localhost:5432/postgres)
 *   2. kiloclaw worker running locally (pnpm start → localhost:8795)
 *
 * The test reads secrets from kiloclaw/.dev.vars so it works without manual env setup.
 *
 * Usage:
 *   node kiloclaw/e2e/google-credentials-integration.mjs
 *   DATABASE_URL=postgres://... WORKER_URL=http://localhost:9000 node kiloclaw/e2e/google-credentials-integration.mjs
 */

import { SignJWT } from 'jose';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load secrets from .dev.vars (same file wrangler uses)
// ---------------------------------------------------------------------------

function loadDevVars() {
  const devVarsPath = path.resolve(__dirname, '../.dev.vars');
  const vars = {};
  try {
    const content = fs.readFileSync(devVarsPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^(\w+)="(.*)"/);
      if (match) vars[match[1]] = match[2];
    }
  } catch {
    console.warn('Could not read .dev.vars — using env overrides or defaults');
  }
  return vars;
}

const devVars = loadDevVars();

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8795';
const INTERNAL_SECRET =
  process.env.INTERNAL_SECRET ?? devVars.INTERNAL_API_SECRET ?? 'dev-internal-secret';
const NEXTAUTH_SECRET =
  process.env.NEXTAUTH_SECRET ?? devVars.NEXTAUTH_SECRET ?? 'dev-secret-change-me';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const USER_ID = `test-google-creds-${Date.now()}`;

let pass = 0;
let fail = 0;
const errors = [];
const cleanupFns = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function green(msg) {
  console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`);
}
function red(msg) {
  console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`);
}
function bold(msg) {
  console.log(`\n\x1b[1m${msg}\x1b[0m`);
}

function assertEq(label, expected, actual) {
  if (expected === actual) {
    green(label);
    pass++;
  } else {
    red(`${label} (expected: ${expected}, got: ${actual})`);
    fail++;
    errors.push(label);
  }
}

function assertNotEmpty(label, actual) {
  if (actual && actual !== 'null') {
    green(label);
    pass++;
  } else {
    red(`${label} (got empty/null)`);
    fail++;
    errors.push(label);
  }
}

async function internalGet(path) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { 'x-internal-api-key': INTERNAL_SECRET },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function internalPost(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'x-internal-api-key': INTERNAL_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function internalDelete(path) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'DELETE',
    headers: { 'x-internal-api-key': INTERNAL_SECRET },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

let JWT;

async function jwtPost(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function jwtDelete(path) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${JWT}` },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

async function jwtGet(path) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { authorization: `Bearer ${JWT}` },
  });
  return { status: res.status, json: res.ok ? await res.json() : null };
}

const DUMMY_CREDS = {
  gogConfigTarball: {
    encryptedData: 'dGVzdA==',
    encryptedDEK: 'dGVzdA==',
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  },
  email: 'test@example.com',
};

// ---------------------------------------------------------------------------
// DB: create/remove test user via psql
// ---------------------------------------------------------------------------

function sql(query) {
  return execSync('psql "$PGURL" -tAc "$PGQUERY"', {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, PGURL: DATABASE_URL, PGQUERY: query },
    shell: '/bin/sh',
  }).trim();
}

function createTestUser() {
  sql(
    `INSERT INTO kilocode_users (id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, api_token_pepper) VALUES ('${USER_ID}', '${USER_ID}@test.local', 'Test User', '', 'cus_test_${USER_ID}', NULL) ON CONFLICT (id) DO NOTHING`
  );
  cleanupFns.push(() => {
    try {
      sql(`DELETE FROM kilocode_users WHERE id = '${USER_ID}'`);
    } catch {}
  });
}

function checkDbConnection() {
  try {
    sql('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generate JWT (needed for both public-key and admin routes)
// ---------------------------------------------------------------------------

async function generateJwt(userId) {
  return new SignJWT({
    kiloUserId: userId,
    apiTokenPepper: null, // matches NULL in DB
    version: 3,
    env: 'development',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode(NEXTAUTH_SECRET));
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

bold('Preflight');

// Check worker
try {
  const health = await fetch(`${WORKER_URL}/health`);
  if (!health.ok) throw new Error(`status ${health.status}`);
  green('Worker reachable at ' + WORKER_URL);
} catch (e) {
  red(`Worker not reachable at ${WORKER_URL}: ${e.message}`);
  console.log('   Is it running? (cd kiloclaw && pnpm start)');
  process.exit(1);
}

// Connect to DB and create test user
let dbConnected = false;
if (checkDbConnection()) {
  try {
    createTestUser();
    dbConnected = true;
    green('DB connected, test user created (id=' + USER_ID + ')');
  } catch (e) {
    red(`Failed to create test user: ${e.message}`);
  }
} else {
  red('DB not reachable — JWT auth tests will be skipped');
  console.log(`   Ensure Postgres is running at ${DATABASE_URL}`);
}

// ---------------------------------------------------------------------------
// 1. Public key endpoint (requires JWT auth at /api/admin/public-key)
// ---------------------------------------------------------------------------

bold('1. Public key endpoint');

if (dbConnected) {
  JWT = await generateJwt(USER_ID);

  const { status: pubKeyStatus, json: pubKeyJson } = await jwtGet('/api/admin/public-key');
  assertEq('GET /api/admin/public-key returns 200', 200, pubKeyStatus);
  assertNotEmpty('Response contains a public key', pubKeyJson?.publicKey);
  assertEq('Public key is valid PEM', true, pubKeyJson?.publicKey?.includes('BEGIN PUBLIC KEY'));
} else {
  bold('1. Public key endpoint — SKIPPED (no DB for JWT)');
}

// ---------------------------------------------------------------------------
// 2. Provision a test instance
// ---------------------------------------------------------------------------

bold(`2. Provision test instance (userId=${USER_ID})`);

// Fire off provision without waiting — it can take 60s+ to create Fly app + machine.
// We only need the DO to exist for google-credentials tests, so poll status instead.
const provisionController = new AbortController();
const provisionPromise = fetch(`${WORKER_URL}/api/platform/provision`, {
  method: 'POST',
  headers: { 'x-internal-api-key': INTERNAL_SECRET, 'content-type': 'application/json' },
  body: JSON.stringify({ userId: USER_ID }),
  signal: provisionController.signal,
}).catch(() => {});
green('Provision request fired (not waiting for completion)');

// Poll status until the DO is reachable (google-credentials endpoint works once DO exists)
let doReachable = false;
for (let i = 0; i < 30; i++) {
  const { status } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
  if (status !== 404) {
    green('Instance DO reachable');
    doReachable = true;
    break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
provisionController.abort();
if (!doReachable) {
  red('Instance DO never became reachable after 30s — provision may have failed');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Platform API: store Google credentials
// ---------------------------------------------------------------------------

bold('3. Platform API: store Google credentials');

const { json: storeResult } = await internalPost('/api/platform/google-credentials', {
  userId: USER_ID,
  googleCredentials: DUMMY_CREDS,
});
assertEq(
  'POST google-credentials returns googleConnected=true',
  true,
  storeResult?.googleConnected
);

const { json: statusAfterStore } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
assertEq('GET status shows googleConnected=true', true, statusAfterStore?.googleConnected);

const { json: debugAfterStore } = await internalGet(`/api/platform/debug-status?userId=${USER_ID}`);
assertEq('GET debug-status shows googleConnected=true', true, debugAfterStore?.googleConnected);

// ---------------------------------------------------------------------------
// 4. Platform API: clear Google credentials
// ---------------------------------------------------------------------------

bold('4. Platform API: clear Google credentials');

const { json: clearResult } = await internalDelete(
  `/api/platform/google-credentials?userId=${USER_ID}`
);
assertEq(
  'DELETE google-credentials returns googleConnected=false',
  false,
  clearResult?.googleConnected
);

const { json: statusAfterClear } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
assertEq('GET status shows googleConnected=false', false, statusAfterClear?.googleConnected);

// ---------------------------------------------------------------------------
// 5. User-facing routes (JWT auth)
// ---------------------------------------------------------------------------

if (dbConnected) {
  bold('5. User-facing routes (JWT auth)');

  // JWT already generated in section 1
  assertNotEmpty('JWT generated', JWT);

  // Auth check — GET /api/admin/google-credentials returns 200 with googleConnected status
  const { status: authCode, json: authJson } = await jwtGet('/api/admin/google-credentials');
  assertEq('Auth check returns 200', 200, authCode);
  assertEq('Auth check returns googleConnected field', false, authJson?.googleConnected);

  // Store via user-facing route
  const { json: storeJwt } = await jwtPost('/api/admin/google-credentials', {
    googleCredentials: DUMMY_CREDS,
  });
  assertEq(
    'POST /api/admin/google-credentials returns googleConnected=true',
    true,
    storeJwt?.googleConnected
  );

  // Verify via platform status
  const { json: statusJwt } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
  assertEq(
    'Status confirms googleConnected=true after JWT store',
    true,
    statusJwt?.googleConnected
  );

  // Clear via user-facing route
  const { json: clearJwt } = await jwtDelete('/api/admin/google-credentials');
  assertEq(
    'DELETE /api/admin/google-credentials returns googleConnected=false',
    false,
    clearJwt?.googleConnected
  );

  // Verify cleared
  const { json: statusJwt2 } = await internalGet(`/api/platform/status?userId=${USER_ID}`);
  assertEq(
    'Status confirms googleConnected=false after JWT clear',
    false,
    statusJwt2?.googleConnected
  );
} else {
  bold('5. User-facing routes (JWT auth) — SKIPPED (no DB)');
}

// ---------------------------------------------------------------------------
// 6. Validation: bad input rejected
// ---------------------------------------------------------------------------

bold('6. Validation: bad input rejected');

// Missing googleCredentials field (internal API)
const { status: badCode1 } = await internalPost('/api/platform/google-credentials', {
  userId: USER_ID,
  wrong: 'field',
});
assertEq('Rejects missing googleCredentials (400)', 400, badCode1);

// Invalid envelope schema (internal API)
const { status: badCode2 } = await internalPost('/api/platform/google-credentials', {
  userId: USER_ID,
  googleCredentials: { gogConfigTarball: { bad: 'data' } },
});
assertEq('Rejects invalid envelope schema (400)', 400, badCode2);

// Unauthenticated request (user-facing route, no token)
const unauthRes = await fetch(`${WORKER_URL}/api/admin/google-credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ googleCredentials: DUMMY_CREDS }),
});
assertEq('Rejects unauthenticated request (401)', 401, unauthRes.status);

// No internal API key (platform route)
const noKeyRes = await fetch(`${WORKER_URL}/api/platform/google-credentials`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: USER_ID, googleCredentials: DUMMY_CREDS }),
});
assertEq('Rejects request without internal API key (403)', 403, noKeyRes.status);

// Bad JWT (user-facing route)
if (dbConnected) {
  const badJwtRes = await fetch(`${WORKER_URL}/api/admin/google-credentials`, {
    method: 'POST',
    headers: { authorization: 'Bearer not.a.real.token', 'content-type': 'application/json' },
    body: JSON.stringify({ googleCredentials: DUMMY_CREDS }),
  });
  assertEq('Rejects bad JWT (401)', 401, badJwtRes.status);
}

// ---------------------------------------------------------------------------
// 7. Idempotency (via internal API)
// ---------------------------------------------------------------------------

bold('7. Idempotency');

await internalPost('/api/platform/google-credentials', {
  userId: USER_ID,
  googleCredentials: DUMMY_CREDS,
});
const { json: secondStore } = await internalPost('/api/platform/google-credentials', {
  userId: USER_ID,
  googleCredentials: DUMMY_CREDS,
});
assertEq('Double store still returns googleConnected=true', true, secondStore?.googleConnected);

await internalDelete(`/api/platform/google-credentials?userId=${USER_ID}`);
const { json: secondClear } = await internalDelete(
  `/api/platform/google-credentials?userId=${USER_ID}`
);
assertEq('Double clear still returns googleConnected=false', false, secondClear?.googleConnected);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

bold('Cleanup');
await internalPost('/api/platform/destroy', { userId: USER_ID }).catch(() => {});
green('Test instance destroyed');

for (const fn of cleanupFns) {
  try {
    fn();
  } catch {}
}
green('Test user removed from DB');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
bold(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  red('Failed tests:');
  errors.forEach(e => red(`  - ${e}`));
  process.exit(1);
} else {
  green('All tests passed!');
}
