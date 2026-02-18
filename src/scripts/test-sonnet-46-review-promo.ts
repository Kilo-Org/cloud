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
  REVIEW_PROMO_START,
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
// NEXTAUTH_SECRET is validated above so this is safe
const secret = NEXTAUTH_SECRET;

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

async function chatRequest(token: string, model: string, stream = false) {
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
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
      max_tokens: 10,
    }),
  });
}

/**
 * Parse the final SSE usage chunk from a streaming response.
 * Returns the `usage` object from the last chunk that contains one, or null.
 */
async function parseUsageFromSSEStream(
  response: Response
): Promise<{
  cost?: number;
  cost_details?: { upstream_inference_cost?: number };
  [k: string]: unknown;
} | null> {
  const text = await response.text();
  let lastUsage: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json?.usage) lastUsage = json.usage;
    } catch {
      // ignore parse errors
    }
  }
  return lastUsage;
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
  // Verifies that a reviewer using the promo model can still make requests even when they have zero balance
  {
    // Save original microdollars_used, then zero the balance
    const { rows: balRows } = await client.query<{ microdollars_used: string }>(
      `SELECT microdollars_used FROM kilocode_users WHERE id = $1`,
      [user.id]
    );
    const origUsed = balRows[0]?.microdollars_used ?? '0';
    await client.query(
      `UPDATE kilocode_users SET microdollars_used = total_microdollars_acquired WHERE id = $1`,
      [user.id]
    );
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL);
    // Restore original balance
    await client.query(`UPDATE kilocode_users SET microdollars_used = $2 WHERE id = $1`, [
      user.id,
      origUsed,
    ]);
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

  // ─── Test 8: Admin stats query (direct SQL, mirrors getReviewPromotionStats) ─
  {
    try {
      const { rows: aggRows } = await client.query<{
        total_requests: string;
        unique_users: string;
        unique_orgs: string;
      }>(
        `SELECT COUNT(*) AS total_requests,
                COUNT(DISTINCT mu.kilo_user_id) AS unique_users,
                COUNT(DISTINCT mu.organization_id) AS unique_orgs
         FROM microdollar_usage mu
         INNER JOIN microdollar_usage_metadata mum ON mu.id = mum.id
         WHERE mu.requested_model = $1
           AND mu.cost = 0
           AND (mum.is_user_byok IS NULL OR mum.is_user_byok = false)
           AND mu.created_at >= $2
           AND mu.created_at < $3`,
        [REVIEW_PROMO_MODEL, REVIEW_PROMO_START, REVIEW_PROMO_END]
      );

      const { rows: dailyRows } = await client.query<{
        day: string;
        total: string;
        unique_users: string;
      }>(
        `SELECT DATE_TRUNC('day', mu.created_at)::date::text AS day,
                COUNT(*) AS total,
                COUNT(DISTINCT mu.kilo_user_id) AS unique_users
         FROM microdollar_usage mu
         INNER JOIN microdollar_usage_metadata mum ON mu.id = mum.id
         WHERE mu.requested_model = $1
           AND mu.cost = 0
           AND (mum.is_user_byok IS NULL OR mum.is_user_byok = false)
           AND mu.created_at >= $2
           AND mu.created_at < $3
         GROUP BY DATE_TRUNC('day', mu.created_at)
         ORDER BY DATE_TRUNC('day', mu.created_at)`,
        [REVIEW_PROMO_MODEL, REVIEW_PROMO_START, REVIEW_PROMO_END]
      );

      const agg = aggRows[0];
      const data = {
        promoActive: isActiveReviewPromo('reviewer', REVIEW_PROMO_MODEL),
        promoStart: REVIEW_PROMO_START,
        promoEnd: REVIEW_PROMO_END,
        totalRequests: Number(agg.total_requests) || 0,
        uniqueUsers: Number(agg.unique_users) || 0,
        uniqueOrgs: Number(agg.unique_orgs) || 0,
        daily: dailyRows.map(row => ({
          day: row.day,
          total: Number(row.total) || 0,
          uniqueUsers: Number(row.unique_users) || 0,
        })),
      };

      const hasShape =
        typeof data.promoActive === 'boolean' &&
        typeof data.promoStart === 'string' &&
        typeof data.promoEnd === 'string' &&
        typeof data.totalRequests === 'number' &&
        typeof data.uniqueUsers === 'number' &&
        typeof data.uniqueOrgs === 'number' &&
        Array.isArray(data.daily);

      record(
        'Admin stats query',
        hasShape,
        `hasShape=${hasShape}, totalRequests=${data.totalRequests}, uniqueUsers=${data.uniqueUsers}`
      );
    } catch (err) {
      record('Admin stats query', false, `Error: ${err}`);
    }
  }

  // ─── Test 9: Streaming response has cost zeroed in SSE stream ───────
  {
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL, true);
    if (res.status !== 200) {
      record('Stream cost zeroed (SSE)', false, `HTTP ${res.status} (expected 200)`);
    } else {
      const usage = await parseUsageFromSSEStream(res);
      if (!usage) {
        record('Stream cost zeroed (SSE)', false, 'No usage chunk found in stream');
      } else {
        const costZeroed = usage.cost === 0;
        const upstreamZeroed =
          !usage.cost_details || usage.cost_details.upstream_inference_cost === 0;
        record(
          'Stream cost zeroed (SSE)',
          costZeroed && upstreamZeroed,
          `cost=${usage.cost} (expected 0), upstream=${usage.cost_details?.upstream_inference_cost ?? 'n/a'} (expected 0)`
        );
      }
    }
  }

  // ─── Test 10: Non-streaming JSON response has cost zeroed ─────────
  {
    const token = mintToken(user.id, user.api_token_pepper, { botId: 'reviewer' });
    const res = await chatRequest(token, REVIEW_PROMO_MODEL, false);
    if (res.status !== 200) {
      record('JSON cost zeroed', false, `HTTP ${res.status} (expected 200)`);
    } else {
      const json = (await res.json()) as {
        usage?: { cost?: number; cost_details?: { upstream_inference_cost?: number } };
      };
      if (!json?.usage) {
        record('JSON cost zeroed', false, 'No usage in JSON response');
      } else {
        const costZeroed = json.usage.cost === 0;
        const upstreamZeroed =
          !json.usage.cost_details || json.usage.cost_details.upstream_inference_cost === 0;
        record(
          'JSON cost zeroed',
          costZeroed && upstreamZeroed,
          `cost=${json.usage.cost} (expected 0), upstream=${json.usage.cost_details?.upstream_inference_cost ?? 'n/a'} (expected 0)`
        );
      }
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
