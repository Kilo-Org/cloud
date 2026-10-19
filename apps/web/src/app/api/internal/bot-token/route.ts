/**
 * Internal API: mint a short-lived, dual-audience token for an internal bot
 * user (`bot-internal-<slug>`), such as the bouncer watch or the auto-routing
 * benchmark. Each workload runs as its own bot user, so it gets its own
 * per-user gateway limits instead of sharing a human's.
 *
 * Auth: `Authorization: Bearer <BOT_TOKEN_MINT_SECRET>`. The secret only
 * authenticates this mint and fails closed when unset.
 *
 * Only internal bots are eligible: the `bot-internal-` id prefix, `is_bot`,
 * not blocked, a non-empty API-token pepper, and an owner or member role in
 * the requested organization. Humans and per-org product bots are refused.
 *
 * URL: POST /api/internal/bot-token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  BOT_TOKEN_MINT_SECRET,
  isResourceTokenIssuanceEnabled,
  NEXTAUTH_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import jwt from 'jsonwebtoken';
import { INTERNAL_BOT_USER_ID_PREFIX } from '@/lib/bot-users/types';

const RequestSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
});

const ONE_HOUR_IN_SECONDS = 60 * 60;

export async function POST(req: NextRequest) {
  const secret = extractBearerToken(req.headers.get('authorization'));
  if (!BOT_TOKEN_MINT_SECRET || !secret || !timingSafeEqual(secret, BOT_TOKEN_MINT_SECRET)) {
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
  const { userId, organizationId } = parsed.data;

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  if (
    !user.id.startsWith(INTERNAL_BOT_USER_ID_PREFIX) ||
    user.is_bot !== true ||
    user.blocked_at !== null ||
    user.blocked_reason !== null ||
    typeof user.api_token_pepper !== 'string' ||
    user.api_token_pepper.trim().length === 0
  ) {
    return NextResponse.json({ error: 'User is not an internal bot' }, { status: 403 });
  }

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
  if (!membership) {
    return NextResponse.json({ error: 'Organization membership not found' }, { status: 404 });
  }
  const organizationRole = membership.role;
  if (organizationRole !== 'owner' && organizationRole !== 'member') {
    return NextResponse.json(
      { error: 'Organization role is not supported for bot tokens' },
      { status: 403 }
    );
  }

  const extraPayload = { tokenSource: 'internal-bot', organizationId, organizationRole };

  if (!isResourceTokenIssuanceEnabled('internal-bot')) {
    const legacyToken = generateApiToken(user, extraPayload, {
      expiresIn: ONE_HOUR_IN_SECONDS,
    });
    return NextResponse.json({
      token: legacyToken,
      expiresAt: new Date(Date.now() + ONE_HOUR_IN_SECONDS * 1000).toISOString(),
    });
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ONE_HOUR_IN_SECONDS;
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
      extra: extraPayload,
    }),
    NEXTAUTH_SECRET,
    { algorithm: 'HS256' }
  );
  return NextResponse.json({
    token: signedToken,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}
