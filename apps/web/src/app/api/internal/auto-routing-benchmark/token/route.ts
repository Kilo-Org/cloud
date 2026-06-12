/**
 * Internal API: mint a short-lived user API token for the auto-routing
 * decider benchmark.
 *
 * Called by:
 * - services/auto-routing-benchmark — the decider benchmark runs each case
 *   through the real `kilo` CLI inside a Cloudflare Container. The CLI
 *   authenticates against the gateway with a user API token, so the worker
 *   fetches a fresh, short-lived token for the configured benchmark user
 *   once per queue message.
 *
 * Auth: shared internal secret over `Authorization: Bearer <secret>` — this
 * is the exact header the benchmark worker sends
 * (`Authorization: Bearer ${INTERNAL_API_SECRET_PROD}`), and
 * INTERNAL_API_SECRET_PROD holds the same value as INTERNAL_API_SECRET here.
 *
 * The minted token is a full user API token (includes apiTokenPepper) so the
 * gateway accepts it as a real user token; an internal-service token would be
 * rejected by gateway pepper validation. It expires in 6 hours.
 *
 * URL: POST /api/internal/auto-routing-benchmark/token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { generateApiToken } from '@/lib/tokens';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const RequestSchema = z.object({ userId: z.string().min(1) });

const SIX_HOURS_IN_SECONDS = 6 * 60 * 60;

// Inline bearer extraction (case-insensitive prefix, RFC 6750 §2.1). Kept local
// to avoid importing @kilocode/worker-utils, whose transitive `jose` ESM import
// breaks under jest's CJS transform.
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return trimmed.slice(7).trim() || null;
}

export async function POST(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, parsed.data.userId))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const apiToken = generateApiToken(
    user,
    { tokenSource: 'auto-routing-benchmark' },
    { expiresIn: SIX_HOURS_IN_SECONDS }
  );
  const expiresAt = new Date(Date.now() + SIX_HOURS_IN_SECONDS * 1000).toISOString();

  return NextResponse.json({ token: apiToken, expiresAt });
}
