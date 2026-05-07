#!/usr/bin/env node
/**
 * KiloClaw × ClawMetry integration end-to-end test.
 *
 * Reproduces the bootstrap step from controller/src/bootstrap.ts in JS,
 * registers a fresh test account against the live ClawMetry cloud
 * (app.clawmetry.com), opens the resulting dashboard URL in a headless
 * browser, and asserts the page renders + decrypts.
 *
 * Run:
 *   node services/kiloclaw/e2e/clawmetry-integration.mjs
 *   HEADLESS=0 node services/kiloclaw/e2e/clawmetry-integration.mjs   # show browser
 *   CLAWMETRY_API_BASE=https://staging.clawmetry.com node …          # staging
 *
 * Exits 0 if all checks pass, 1 on first failure.
 *
 * Why this exists:
 *   - Catches regressions in the bootstrap → register → daemon flow
 *     without spinning up a real KiloClaw instance.
 *   - The browser-side enc_key handoff via URL fragment is impossible to
 *     unit test (it's a race between inline scripts in dashboard.py).
 *     This test exercises the live cloud + Playwright together so a real
 *     human's "click View Observability" experience is what we actually
 *     verify.
 *
 * Limitations:
 *   - Requires network egress to app.clawmetry.com. The test creates a
 *     real (free-tier) account each run; cleanup is best-effort.
 *   - Doesn't generate real OpenClaw activity, so tabs with feed-style
 *     content show empty states. The test asserts the chrome (tabs
 *     render, no decrypt errors), not the data.
 */
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';

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

// ── Bootstrap-equivalent: register a fresh machine + build dashboard URL ──

async function provision() {
  const machineId = `kc-e2e-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // /api/register can return 500 on cold-start or transient DB-pool pressure.
  // Retry a few times with backoff before giving up.
  // 429 = registration-rate-limit hit (10/hour per IP) — bail cleanly so CI
  // doesn't flag the test red on a legitimate cloud defense.
  let body,
    lastErr,
    lastStatus = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: machineId,
        machine_id: machineId,
        platform: 'Linux',
        email: `kc-e2e+${machineId}@clawmetry.com`,
      }),
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
      console.log(`\n[clawmetry-e2e] SKIP: ${lastErr}`);
      console.log('[clawmetry-e2e] Rate limit is per-IP. Wait ~1h or run from a different IP.\n');
      process.exit(0);
    }
    throw new Error(lastErr || '/api/register failed after retries');
  }

  // The `nodes` table is only populated by the sync daemon's first POST to
  // /api/ingest/heartbeat — until then, the dashboard renders "Node not
  // found". In production, KiloClaw spawns the daemon on the user's first
  // "View Observability" click, which races with the dashboard load. Here
  // we simulate the first heartbeat synchronously so the dashboard loads
  // deterministically. (This mirrors what services/kiloclaw/controller's
  // clawmetry-start-sync route triggers — minus the spawn.)
  const hbRes = await fetch(`${API_BASE}/ingest/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${body.api_key}`,
    },
    body: JSON.stringify({
      node_id: body.node_id,
      hostname: machineId,
      platform: 'Linux',
      version: 'e2e-test',
    }),
  });
  if (!hbRes.ok) {
    throw new Error(`/api/ingest/heartbeat returned ${hbRes.status}: ${await hbRes.text()}`);
  }

  const encKey = crypto.randomBytes(32).toString('base64');
  const dashboardUrl =
    `${API_BASE}/cloud/node/${encodeURIComponent(body.node_id)}` +
    `?token=${encodeURIComponent(body.api_key)}` +
    `#key=${encodeURIComponent(encKey)}&node=${encodeURIComponent(body.node_id)}`;
  return { ...body, encKey, dashboardUrl };
}

// Retry wrapper for the dashboard load — handles cold-start instances and
// the intermittent /cloud/node/<id> 200/stub flake under load.
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

// ── The actual test flow ─────────────────────────────────────────────────

async function main() {
  console.log(`[clawmetry-e2e] target: ${API_BASE}`);
  console.log(`[clawmetry-e2e] headless: ${HEADLESS}\n`);

  console.log('▸ Provisioning fresh test account via /api/register');
  const p = await provision();
  console.log(`  api_key:      ${p.api_key.slice(0, 16)}…`);
  console.log(`  node_id:      ${p.node_id}`);
  console.log(`  dashboard_id: ${p.dashboard_id}`);
  check(
    'register response: api_key shape',
    /^cm_[a-f0-9]{32}$/.test(p.api_key),
    `got ${p.api_key.slice(0, 24)}…`
  );
  check(
    'register response: dashboard_id is uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.dashboard_id),
    p.dashboard_id
  );
  check('register response: node_id present', !!p.node_id);
  check('register response: plan is free', p.plan === 'free', `plan=${p.plan}`);

  console.log('\n▸ /api/cloud/account reports the new account');
  const accRes = await fetch(
    `${API_BASE}/api/cloud/account?token=${encodeURIComponent(p.api_key)}`
  );
  const account = await accRes.json();
  check('account: ok=true', account.ok === true);
  check('account: plan=free', account.plan === 'free');
  // Note: account.node_count is a Stripe-driven counter, not a row count.
  // It stays 0 for fresh free-tier signups (no billing event yet) — don't
  // assert on it here; the dashboard-load check below proves the node
  // landed in the `nodes` table.

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

  let attemptsUsed;
  try {
    attemptsUsed = await openDashboardWithRetry(page, p.dashboardUrl);
    check('dashboard loaded CLOUD_MODE within retries', true, `(took ${attemptsUsed} attempt(s))`);
  } catch (err) {
    check('dashboard loaded CLOUD_MODE within retries', false, err.message);
    await browser.close();
    return;
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(3000);

  const state = await page.evaluate(() => {
    return {
      cloudMode: window.CLOUD_MODE,
      cloudNodeId: window.CLOUD_NODE_ID,
      cloudTokenPrefix: (window.CLOUD_TOKEN || '').slice(0, 16),
      url: window.location.href,
      bodyLen: (document.body.innerText || '').length,
      bodyText: (document.body.innerText || '').slice(0, 400),
      encKeyValue: (() => {
        const k = Object.keys(localStorage).find(x => x.startsWith('cm-enc-key-'));
        return k ? localStorage.getItem(k) : null;
      })(),
    };
  });

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

  console.log('\n▸ Walking key feature tabs');
  const screenshotDir = process.env.SCREENSHOT_DIR;
  if (screenshotDir) {
    await fs.promises.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/00_landing.png` });
  }
  // Real free-tier tabs as rendered by the cloud dashboard (verified in
  // browser). Pro adds more tabs but the integration only ever lands users
  // on Free, so this is the correct surface to assert against.
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
  let tabIdx = 0;
  for (const tab of TABS) {
    tabIdx++;
    const errBefore = errors.length;
    const t = page.locator(`.nav-tab:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first();
    const visible = (await t.count()) > 0;
    if (!visible) {
      check(`${tab} tab visible`, false);
      continue;
    }
    await t.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const tabState = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        bodyLen: text.length,
        hasUnlock: text.toLowerCase().includes('enter your secret key'),
        hasDecryptFail: text.toLowerCase().includes('could not decrypt activity'),
        snippet: text.replace(/\s+/g, ' ').slice(0, 140),
      };
    });
    if (screenshotDir) {
      await page
        .screenshot({
          path: `${screenshotDir}/${String(tabIdx).padStart(2, '0')}_${tab.toLowerCase()}.png`,
        })
        .catch(() => undefined);
    }
    check(
      `${tab}: tab opens (body > 200 chars)`,
      tabState.bodyLen > 200,
      `body=${tabState.bodyLen} snippet="${tabState.snippet}"`
    );
    check(`${tab}: no unlock prompt`, !tabState.hasUnlock);
    check(`${tab}: no decrypt failure`, !tabState.hasDecryptFail);
    check(`${tab}: no new JS errors`, errors.length === errBefore);
  }

  console.log('\n▸ JS error filter (ignoring known harmless warnings)');
  // - "Unexpected string" — pre-existing JS quirk in dashboard.py inline scripts
  // - 410 from /api/skills — intentional deprecated endpoint with friendly response
  // - posthog/clarity/analytics — third-party trackers
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
  console.error('\n[clawmetry-e2e] FATAL:', err);
  process.exit(1);
});
