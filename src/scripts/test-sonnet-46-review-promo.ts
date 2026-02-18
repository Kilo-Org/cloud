/**
 * Test script: verify Sonnet 4.6 free code review promotion.
 *
 * Generates a reviewer JWT matching actual prepare-review-payload.ts behavior
 * (botId: 'reviewer', no internalApiUse) and exercises the promo logic.
 *
 * Run with:
 *   pnpm script src/scripts/test-sonnet-46-review-promo.ts
 */

import pg from 'pg';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  isActiveReviewPromo,
  REVIEW_PROMO_MODEL,
  REVIEW_PROMO_END,
} from '@/lib/code-reviews/core/constants';

const root = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, '.env.local'), override: true });

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET not set');
if (!POSTGRES_URL) throw new Error('POSTGRES_URL not set');

const JWT_TOKEN_VERSION = 3;
const BASE_URL = 'http://localhost:3000';
const secret: string = NEXTAUTH_SECRET;

type TestResult = { name: string; passed: boolean; detail: string };
const results: TestResult[] = [];

function mintToken(
  userId: string,
  pepper: string,
  overrides: Record<string, unknown> = {}
): string {
  return jwt.sign(
    {
      env: process.env.NODE_ENV ?? 'development',
      kiloUserId: userId,
      apiTokenPepper: pepper,
      version: JWT_TOKEN_VERSION,
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn: 300 }
  );
}

async function chatRequest(token: string, model: string) {
  return fetch(`${BASE_URL}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      stream: false,
      max_tokens: 10,
    }),
  });
}

function record(name: string, passed: boolean, detail: string) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅ PASS' : '❌ FAIL'} [${name}] ${detail}`);
}

async function main() {
  const client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();

  const { rows } = await client.query<{
    id: string;
    api_token_pepper: string;
    google_user_email: string;
  }>('SELECT id, api_token_pepper, google_user_email FROM kilocode_users LIMIT 1');

  const user = rows[0];
  if (!user) throw new Error('No users found in DB');
  console.log(`Using user: ${user.id} (${user.google_user_email})\n`);

  // ─── Test 1: Promo model accepted ────────────────────────────────────
  {
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL);
    record('Promo model accepted', res.status === 200, `HTTP ${res.status} (expected 200)`);
  }

  // ─── Test 2: Cost is zeroed ──────────────────────────────────────────
  {
    // Small delay so the usage row has been written
    await new Promise(r => setTimeout(r, 3000));
    const { rows: usageRows } = await client.query<{ cost: string }>(
      `SELECT cost FROM microdollar_usage
       WHERE kilo_user_id = $1
         AND requested_model = $2
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, REVIEW_PROMO_MODEL]
    );
    const cost = usageRows[0] ? Number(usageRows[0].cost) : -1;
    record('Cost is zeroed', cost === 0, `cost = ${cost} (expected 0)`);
  }

  // ─── Test 3: Non-promo model not free ────────────────────────────────
  {
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, 'anthropic/claude-opus-4.6');
    // Should either work (cost > 0) or be balance-gated (402)
    await new Promise(r => setTimeout(r, 3000));
    const { rows: usageRows } = await client.query<{ cost: string }>(
      `SELECT cost FROM microdollar_usage
       WHERE kilo_user_id = $1
         AND requested_model = 'anthropic/claude-opus-4.6'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const cost = usageRows[0] ? Number(usageRows[0].cost) : -1;
    const passed = res.status === 402 || cost > 0;
    record('Non-promo model not free', passed, `HTTP ${res.status}, cost = ${cost}`);
  }

  // ─── Test 4: Non-reviewer botId not free ─────────────────────────────
  {
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'other' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL);
    await new Promise(r => setTimeout(r, 3000));
    const { rows: usageRows } = await client.query<{ cost: string }>(
      `SELECT cost FROM microdollar_usage
       WHERE kilo_user_id = $1
         AND requested_model = $2
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, REVIEW_PROMO_MODEL]
    );
    const cost = usageRows[0] ? Number(usageRows[0].cost) : -1;
    // If the promo window is active, a non-reviewer botId should still pay
    const passed = res.status === 402 || cost > 0;
    record('Non-reviewer botId not free', passed, `HTTP ${res.status}, cost = ${cost}`);
  }

  // ─── Test 5: No botId not free ───────────────────────────────────────
  {
    const token = mintToken(user.id, user.api_token_pepper);
    const res = await chatRequest(token, REVIEW_PROMO_MODEL);
    await new Promise(r => setTimeout(r, 3000));
    const { rows: usageRows } = await client.query<{ cost: string }>(
      `SELECT cost FROM microdollar_usage
       WHERE kilo_user_id = $1
         AND requested_model = $2
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, REVIEW_PROMO_MODEL]
    );
    const cost = usageRows[0] ? Number(usageRows[0].cost) : -1;
    const passed = res.status === 402 || cost > 0;
    record('No botId not free', passed, `HTTP ${res.status}, cost = ${cost}`);
  }

  // ─── Test 6: Balance gate bypass ─────────────────────────────────────
  {
    // Temporarily set user balance to 0 for this test
    await client.query(
      `UPDATE kilocode_users SET microdollars_used = microdollars_lifetime_total WHERE id = $1`,
      [user.id]
    );
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL);
    // Restore balance
    await client.query(`UPDATE kilocode_users SET microdollars_used = 0 WHERE id = $1`, [user.id]);
    record(
      'Balance gate bypass',
      res.status === 200,
      `HTTP ${res.status} with 0 balance (expected 200)`
    );
  }

  // ─── Test 7: isActiveReviewPromo unit test ───────────────────────────
  {
    const now = Date.now();
    const inWindow = now < Date.parse(REVIEW_PROMO_END);

    const resultTrue = isActiveReviewPromo('reviewer', REVIEW_PROMO_MODEL);
    const resultWrongBot = isActiveReviewPromo('other', REVIEW_PROMO_MODEL);
    const resultWrongModel = isActiveReviewPromo('reviewer', 'anthropic/claude-opus-4.6');
    const resultUndefined = isActiveReviewPromo(undefined, REVIEW_PROMO_MODEL);

    const allCorrect =
      resultTrue === inWindow &&
      resultWrongBot === false &&
      resultWrongModel === false &&
      resultUndefined === false;

    record(
      'isActiveReviewPromo unit',
      allCorrect,
      `inWindow=${inWindow}, reviewer+promo=${resultTrue}, other+promo=${resultWrongBot}, reviewer+opus=${resultWrongModel}, undefined+promo=${resultUndefined}`
    );
  }

  // ─── Test 8: Admin stats endpoint ────────────────────────────────────
  {
    // Make user admin temporarily
    await client.query(`UPDATE kilocode_users SET is_admin = true WHERE id = $1`, [user.id]);
    const token = mintToken(user.id, user.api_token_pepper);
    try {
      const res = await fetch(`${BASE_URL}/api/trpc/adminCodeReviews.getReviewPromotionStats`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json();
      const data = body?.result?.data;
      const hasShape =
        data &&
        typeof data.promoActive === 'boolean' &&
        typeof data.promoStart === 'string' &&
        typeof data.promoEnd === 'string' &&
        typeof data.totalRequests === 'number' &&
        typeof data.uniqueUsers === 'number' &&
        typeof data.uniqueOrgs === 'number' &&
        Array.isArray(data.daily);

      record(
        'Admin stats endpoint',
        res.status === 200 && hasShape,
        `HTTP ${res.status}, hasShape=${hasShape}`
      );
    } finally {
      await client.query(`UPDATE kilocode_users SET is_admin = false WHERE id = $1`, [user.id]);
    }
  }

  await client.end();

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│         SONNET 4.6 REVIEW PROMO TESTS       │');
  console.log('├──────┬──────────────────────────────────────┤');
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`│ ${status} │ ${r.name.padEnd(40)}│`);
  }
  console.log('├──────┴──────────────────────────────────────┤');
  const passed = results.filter(r => r.passed).length;
  console.log(`│ ${passed}/${results.length} tests passed${' '.repeat(30)}│`);
  console.log('└─────────────────────────────────────────────┘');

  if (passed < results.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
