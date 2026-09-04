/**
 * Internal API: mint a short-lived, dual-audience user token for the
 * auto-routing decider benchmark.
 *
 * Called by:
 * - services/auto-routing-benchmark — the decider benchmark runs each case
 *   through the real `kilo` CLI inside a Cloudflare Container. The CLI
 *   authenticates with a user API token. The immutable CLI resolves its
 *   catalog, profile, defaults, and provider gateway requests from
 *   KILO_API_URL, so the worker fetches one fresh token for the configured
 *   benchmark user once per queue message.
 *
 * Auth: shared internal secret over `Authorization: Bearer <secret>` — this
 * is the exact header the benchmark worker sends
 * (`Authorization: Bearer ${INTERNAL_API_SECRET_PROD}`), and
 * INTERNAL_API_SECRET_PROD holds the same value as INTERNAL_API_SECRET here.
 *
 * Token issuance requires shared-resource tokens, an active benchmark user
 * with a non-empty API-token pepper, and (when supplied) a current owner or
 * member organization membership. The token includes that pepper so API and
 * gateway requests validate it as a real user token; an internal-service token
 * would be rejected by gateway pepper validation. It expires in 6 hours.
 *
 * URL: POST /api/internal/auto-routing-benchmark/token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  isSharedResourceTokenIssuanceEnabled,
  INTERNAL_API_SECRET,
  NEXTAUTH_SECRET,
} from '@/lib/config.server';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import jwt from 'jsonwebtoken';

const RequestSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1).optional(),
});

const SIX_HOURS_IN_SECONDS = 6 * 60 * 60;

export async function POST(req: NextRequest) {
  const token = extractBearerToken(req.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSharedResourceTokenIssuanceEnabled()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
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
  if (
    typeof user.api_token_pepper !== 'string' ||
    user.api_token_pepper.trim().length === 0 ||
    user.blocked_at !== null ||
    user.blocked_reason !== null
  ) {
    return NextResponse.json(
      { error: 'User is not eligible for benchmark tokens' },
      { status: 403 }
    );
  }

  const extraPayload = { tokenSource: 'auto-routing-benchmark' };
  const organizationId = parsed.data.organizationId;
  let organizationRole: 'owner' | 'member' | undefined;
  if (organizationId) {
    const role = await getOrganizationRole(parsed.data.userId, organizationId);
    if (role === null) {
      return NextResponse.json({ error: 'Organization membership not found' }, { status: 404 });
    }
    if (role !== 'owner' && role !== 'member') {
      return NextResponse.json(
        { error: 'Organization role is not supported for benchmark tokens' },
        { status: 403 }
      );
    }
    organizationRole = role;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SIX_HOURS_IN_SECONDS;
  const signedToken = jwt.sign(
    buildModernKiloTokenPayload({
      userId: user.id,
      pepper: user.api_token_pepper,
      env: process.env.NODE_ENV,
      audience: [KILO_API_AUDIENCE, KILO_GATEWAY_AUDIENCE],
      issuedAt,
      expiresAt,
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      extra: { ...extraPayload, organizationId, organizationRole },
    }),
    NEXTAUTH_SECRET,
    { algorithm: 'HS256' }
  );
  return NextResponse.json({
    token: signedToken,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}

async function getOrganizationRole(userId: string, organizationId: string) {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId)
      )
    )
    .limit(1);

  return membership?.role ?? null;
}
