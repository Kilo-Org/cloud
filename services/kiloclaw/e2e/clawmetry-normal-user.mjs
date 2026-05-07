#!/usr/bin/env node
/**
 * Normal (non-KiloClaw) ClawMetry user end-to-end test.
 *
 * Runs side-by-side with `clawmetry-integration.mjs` (KiloClaw deferred
 * sync) to prove that the deferred-sync gate doesn't regress the standard
 * `pip install clawmetry && clawmetry connect` flow. A normal user must
 * NOT be put into deferred mode — heartbeats and uploads should be
 * allowed from the very first call.
 *
 * Run:
 *   node services/kiloclaw/e2e/clawmetry-normal-user.mjs
 *   HEADLESS=0 node services/kiloclaw/e2e/clawmetry-normal-user.mjs   # show browser
 *
 * Exits 0 if all checks pass, 1 on first failure.
 *
 * What this guards against:
 *   - A future cloud change that accidentally tags every user as deferred
 *     (e.g. fallthrough in the source whitelist).
 *   - A regression in the heartbeat response shape that breaks the OSS
 *     daemon's _TRIAL_STATE update path.
 *   - Dashboard rendering regressions for normal users (the URL form is
 *     different — /d/<dashboard_id> instead of /cloud/node/<id>?token=…).
 *
 * Limitations:
 *   - Doesn't simulate the OTP login that real `clawmetry connect` does.
 *     Instead it talks to /api/register directly, the same way the OSS
 *     CLI would after a successful OTP. The OTP flow itself is exercised
 *     by tests/e2e/test_signup_smoke.py in the OSS repo.
 *   - Doesn't generate real OpenClaw activity, so the dashboard's Brain
 *     feed shows the empty state. We assert the chrome (tabs render,
 *     decryption succeeds, no JS errors), not the data.
 */
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const API_BASE = process.env.CLAWMETRY_API_BASE || 'https://app.clawmetry.com';
const HEADLESS = process.env.HEADLESS !== '0';
const ATTEMPTS = parseInt(process.env.RETRIES || '5', 10);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label + (detail ? `\n      ${detail}` : ''));
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function postJson(path, payload, apiKey) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function provision() {
  const machineId = `cm-normal-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // Same retry wrapper as the kiloclaw test — register can 500 on cold
  // start, 429 means we hit the 10/hour per-IP rate limit.
  let body,
    lastErr,
    lastStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // NOTE: no `source` field — this is what makes the user a normal user
    // instead of a kiloclaw-provisioned one.
    const res = await postJson('/api/register', {
      hostname: machineId,
      machine_id: machineId,
      platform: 'Linux',
      email: `cm-normal+${machineId}@clawmetry.com`,
    });
    if (res.ok) {
      body = await res.json();
      break;
    }
    lastStatus = res.status;
    lastErr = `/api/register returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429) break;
    console.log(`  register attempt ${attempt} failed: ${lastErr}`);
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  if (!body) {
    if (lastStatus === 429) {
      console.log(`\n[clawmetry-normal-user] SKIP: ${lastErr}`);
      console.log(
        '[clawmetry-normal-user] Rate limit is per-IP. Wait ~1h or run from a different IP.\n'
      );
      process.exit(0);
    }
    throw new Error(lastErr || '/api/register failed after retries');
  }

  // Self-decrypting URL pattern is identical to KiloClaw — `clawmetry
  // connect` writes the same config schema, just via a different code
  // path. Using /cloud/node/<id> here means the test exercises the same
  // browser-side bridge that real users hit.
  const encKey = crypto.randomBytes(32).toString('base64');
  const dashboardUrl =
    `${API_BASE}/cloud/node/${encodeURIComponent(body.node_id)}` +
    `?token=${encodeURIComponent(body.api_key)}` +
    `#key=${encodeURIComponent(encKey)}&node=${encodeURIComponent(body.node_id)}`;
  return { ...body, machineId, encKey, dashboardUrl };
}

async function sendHeartbeat(p) {
  const res = await postJson(
    '/ingest/heartbeat',
    { node_id: p.node_id, hostname: p.machineId, platform: 'Linux', version: 'normal-e2e' },
    p.api_key
  );
  if (!res.ok) {
    throw new Error(`/ingest/heartbeat returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function openDashboardWithRetry(page, url, attempts = ATTEMPTS) {
  let lastDiag = '';
  for (let i = 1; i <= attempts; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const diag = await page.evaluate(() => ({
      ready: window.CLOUD_MODE === true && !!window.CLOUD_NODE_ID,
      cloudMode: window.CLOUD_MODE,
      href: location.href,
      bodyHead: (document.body.innerText || '').slice(0, 120).replace(/\s+/g, ' '),
    }));
    if (diag.ready) return i;
    lastDiag = `attempt ${i}: CLOUD_MODE=${diag.cloudMode} href=${diag.href} body="${diag.bodyHead}"`;
    if (process.env.DEBUG) console.log('  ' + lastDiag);
  }
  throw new Error(
    `Dashboard did not load CLOUD_MODE after ${attempts} attempts. Last: ${lastDiag}`
  );
}

async function main() {
  console.log(`[clawmetry-normal-user] target: ${API_BASE}`);
  console.log(`[clawmetry-normal-user] headless: ${HEADLESS}\n`);

  console.log('▸ Register a normal (non-KiloClaw) user via /api/register');
  const p = await provision();
  console.log(`  api_key:      ${p.api_key.slice(0, 16)}…`);
  console.log(`  node_id:      ${p.node_id}`);
  console.log(`  dashboard_id: ${p.dashboard_id}`);
  check('register: api_key shape', /^cm_[a-f0-9]{32}$/.test(p.api_key));
  check(
    'register: dashboard_id is uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.dashboard_id)
  );
  check('register: node_id present', !!p.node_id);
  check('register: plan is free', p.plan === 'free');

  // ── The critical regression check ────────────────────────────────────
  // Heartbeat for a normal user must NOT come back with sync_allowed=false
  // or reason='intent_pending'. If it does, the cloud-side deferred-sync
  // gate has accidentally caught a non-KiloClaw user.
  console.log('\n▸ First heartbeat — must NOT be deferred (no sync_allowed:false)');
  const hb = await sendHeartbeat(p);
  console.log(`  response: ${JSON.stringify(hb)}`);
  check('hb: ok === true', hb.ok === true);
  check('hb: sync_allowed is not false', hb.sync_allowed !== false, JSON.stringify(hb));
  check('hb: reason !== "intent_pending"', hb.reason !== 'intent_pending', JSON.stringify(hb));

  // ── Account API works the same as for a KiloClaw user ────────────────
  console.log('\n▸ /api/cloud/account reports the new account');
  const account = await fetch(
    `${API_BASE}/api/cloud/account?token=${encodeURIComponent(p.api_key)}`
  ).then(r => r.json());
  check('account: ok=true', account.ok === true);
  check('account: plan=free', account.plan === 'free');

  // ── Browser: the dashboard must render + decrypt cleanly ─────────────
  console.log('\n▸ Browser: open dashboard URL with retry');
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('console', m => {
    if (m.type() === 'error') {
      const loc = m.location() || {};
      const where = loc.url ? ` @ ${loc.url}` : '';
      errors.push(`console.error: ${m.text().slice(0, 200)}${where}`);
    }
  });

  try {
    const attemptsUsed = await openDashboardWithRetry(page, p.dashboardUrl);
    check('dashboard loaded CLOUD_MODE within retries', true, `(took ${attemptsUsed} attempt(s))`);
  } catch (err) {
    check('dashboard loaded CLOUD_MODE within retries', false, err.message);
    await browser.close();
    return;
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => ({
    cloudMode: window.CLOUD_MODE,
    cloudNodeId: window.CLOUD_NODE_ID,
    cloudTokenPrefix: (window.CLOUD_TOKEN || '').slice(0, 16),
    url: window.location.href,
    bodyText: (document.body.innerText || '').slice(0, 400),
    encKeyValue: (() => {
      const k = Object.keys(localStorage).find(x => x.startsWith('cm-enc-key-'));
      return k ? localStorage.getItem(k) : null;
    })(),
  }));

  console.log('\n▸ Dashboard auth + decryption hand-off');
  check('window.CLOUD_MODE === true', state.cloudMode === true);
  check('window.CLOUD_NODE_ID matches', state.cloudNodeId === p.node_id);
  check(
    'window.CLOUD_TOKEN matches api_key prefix',
    state.cloudTokenPrefix === p.api_key.slice(0, 16),
    `got ${state.cloudTokenPrefix}`
  );
  check('URL fragment scrubbed (privacy)', !state.url.includes('#key='), state.url);
  check('enc_key landed in localStorage', state.encKeyValue === p.encKey);
  check(
    'no "Enter your secret key" prompt (decryption ready)',
    !state.bodyText.toLowerCase().includes('enter your secret key')
  );
  check('free-tier "24 hours" copy is shown', state.bodyText.includes('Showing last 24 hours'));

  // ── Walk free-tier tabs to catch decrypt / render regressions ────────
  console.log('\n▸ Walking free-tier tabs');
  const TABS = [
    'Flow',
    'Brain',
    'Overview',
    'Approvals',
    'Alerts',
    'Notifications',
    'Context',
    'Tokens',
    'Crons',
    'Memory',
  ];
  for (const tab of TABS) {
    const errBefore = errors.length;
    const t = page.locator(`.nav-tab:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first();
    if ((await t.count()) === 0) {
      check(`${tab} tab visible`, false);
      continue;
    }
    await t.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    const tabState = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        bodyLen: text.length,
        hasUnlock: text.toLowerCase().includes('enter your secret key'),
        hasDecryptFail: text.toLowerCase().includes('could not decrypt activity'),
      };
    });
    check(`${tab}: tab opens (body > 200 chars)`, tabState.bodyLen > 200);
    check(`${tab}: no unlock prompt`, !tabState.hasUnlock);
    check(`${tab}: no decrypt failure`, !tabState.hasDecryptFail);
    check(`${tab}: no new JS errors`, errors.length === errBefore);
  }

  // Same filter list as the kiloclaw test — known-harmless console noise.
  console.log('\n▸ JS error filter (ignoring known harmless warnings)');
  const real = errors.filter(
    e =>
      !/Unexpected string/.test(e) &&
      !(/\/api\/skills/.test(e) && /\b410\b/.test(e)) &&
      !/posthog/i.test(e) &&
      !/clarity/i.test(e) &&
      !/analytics/i.test(e) &&
      !/gtag/i.test(e)
  );
  check(`zero unexpected JS errors`, real.length === 0, real.slice(0, 5).join('\n      '));

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('  ✅ All checks passed');
}

main().catch(err => {
  console.error('\n[clawmetry-normal-user] FATAL:', err);
  process.exit(1);
});
