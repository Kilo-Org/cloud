import 'server-only';

import type { User } from '@kilocode/db/schema';
import {
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { and, eq, gt, isNull } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getResourceDelegationAuthority } from './resource-delegation';

export const HOME_WIDGET_AUDIENCE = 'kilo-home-widget';
export const HOME_WIDGET_CREDENTIAL_SECONDS = 30 * 24 * 60 * 60;

const claimsSchema = z
  .object({
    widgetUserId: z.string().min(1),
    apiTokenPepper: z.string().nullable(),
    organizationId: z.uuid().nullable(),
    deviceSessionId: z.uuid().optional(),
    env: z.string(),
    tokenPurpose: z.literal('home-widget'),
    aud: z.literal(HOME_WIDGET_AUDIENCE),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();
type WidgetClaims = z.infer<typeof claimsSchema>;
export type HomeWidgetPrincipal = { userId: string; organizationId: string | null };

function unauthorized(): never {
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'Widget credential is no longer authorized',
  });
}

async function assertCurrentPrincipal(
  claims: Pick<
    WidgetClaims,
    'widgetUserId' | 'apiTokenPepper' | 'deviceSessionId' | 'organizationId'
  >
): Promise<void> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, claims.widgetUserId),
  });
  if (
    !user ||
    user.blocked_at ||
    user.blocked_reason ||
    user.api_token_pepper !== claims.apiTokenPepper
  ) {
    unauthorized();
  }
  if (claims.deviceSessionId !== undefined) {
    const session = await db.query.device_sessions.findFirst({
      where: and(
        eq(device_sessions.id, claims.deviceSessionId),
        eq(device_sessions.kilo_user_id, user.id),
        isNull(device_sessions.revoked_at)
      ),
    });
    if (!session) unauthorized();
    // Sessions have no expires_at. Their live, unconsumed refresh credential
    // defines the device-auth lifetime; widgets never consume or rotate it.
    const refresh = await db.query.device_refresh_tokens.findFirst({
      where: and(
        eq(device_refresh_tokens.device_session_id, session.id),
        isNull(device_refresh_tokens.consumed_at),
        gt(device_refresh_tokens.expires_at, new Date().toISOString())
      ),
    });
    if (!refresh) unauthorized();
  }
  if (claims.organizationId !== null) {
    const organization = await db.query.organizations.findFirst({
      where: and(eq(organizations.id, claims.organizationId), isNull(organizations.deleted_at)),
    });
    const membership = await db.query.organization_memberships.findFirst({
      where: and(
        eq(organization_memberships.kilo_user_id, user.id),
        eq(organization_memberships.organization_id, claims.organizationId)
      ),
    });
    if (!organization || !membership) unauthorized();
  }
}

/** Only native device sessions receive this long-lived read credential; each read rechecks that session. */
export async function issueHomeWidgetCredential(
  user: User,
  organizationId: string | null,
  requestHeaders?: Headers
): Promise<{ token: string; expiresAt: number }> {
  const authority = await getResourceDelegationAuthority(user, {
    headers: requestHeaders,
    organizationId: organizationId ?? undefined,
  });
  if (authority.user.id !== user.id || authority.deviceSessionId === undefined) {
    unauthorized();
  }
  const now = Math.floor(Date.now() / 1000);
  if (authority.expiresAt !== undefined && authority.expiresAt <= now) unauthorized();
  const claims = {
    widgetUserId: authority.user.id,
    apiTokenPepper: authority.user.api_token_pepper,
    organizationId,
    ...(authority.deviceSessionId === undefined
      ? {}
      : { deviceSessionId: authority.deviceSessionId }),
    env: process.env.NODE_ENV,
    tokenPurpose: 'home-widget' as const,
    aud: HOME_WIDGET_AUDIENCE,
    iat: now,
    exp: now + HOME_WIDGET_CREDENTIAL_SECONDS,
  };
  const validated = claimsSchema.parse(claims);
  await assertCurrentPrincipal(validated);
  return {
    token: jwt.sign(validated, NEXTAUTH_SECRET, { algorithm: 'HS256' }),
    expiresAt: validated.exp * 1000,
  };
}

/** Only dedicated native widget routes call this verifier; ordinary API auth rejects this audience. */
export async function authenticateHomeWidget(
  requestHeaders: Headers
): Promise<HomeWidgetPrincipal> {
  const bearer = requestHeaders.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) unauthorized();
  let claims: WidgetClaims;
  try {
    claims = claimsSchema.parse(
      jwt.verify(bearer, NEXTAUTH_SECRET, {
        algorithms: ['HS256'],
        audience: HOME_WIDGET_AUDIENCE,
      })
    );
  } catch {
    unauthorized();
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.env !== process.env.NODE_ENV ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > HOME_WIDGET_CREDENTIAL_SECONDS
  ) {
    unauthorized();
  }
  await assertCurrentPrincipal(claims);
  return { userId: claims.widgetUserId, organizationId: claims.organizationId };
}
