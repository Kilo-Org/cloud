import { jwtVerify, SignJWT } from 'jose';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { z } from 'zod';

import type { Env } from '../env';

export const SESSION_SHARE_TOKEN_ISSUER = 'kilo-session-ingest';
export const SESSION_SHARE_TOKEN_AUDIENCE = 'kilo-session-share';
export const SESSION_SHARE_TOKEN_VERSION = 1;

const sessionIdSchema = z.string().startsWith('ses_').length(30);
const sessionShareTokenPayloadSchema = z
  .object({
    iss: z.literal(SESSION_SHARE_TOKEN_ISSUER),
    aud: z.literal(SESSION_SHARE_TOKEN_AUDIENCE),
    version: z.literal(SESSION_SHARE_TOKEN_VERSION),
    sub: sessionIdSchema,
    jti: z.uuid(),
    iat: z.number().int().nonnegative().refine(Number.isSafeInteger),
  })
  .strict();

const sessionShareTokenSigningPayloadSchema = z
  .object({
    version: z.literal(SESSION_SHARE_TOKEN_VERSION),
    sub: sessionIdSchema,
    jti: z.uuid(),
  })
  .strict();

export type SessionShareTokenPayload = z.infer<typeof sessionShareTokenPayloadSchema>;

export type ResolvedSessionShare = {
  sessionId: string;
  kiloUserId: string;
  title: string | null;
  ownerName: string | null;
};

export type SessionShareTokenEnv = {
  SESSION_SHARE_JWT_SECRET_PROD: Pick<Env['SESSION_SHARE_JWT_SECRET_PROD'], 'get'>;
  SESSION_SHARE_TOKEN_MIN_IAT: string | undefined;
  HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
};

function parseMinimumIat(rawValue: string | undefined): number {
  const value = rawValue ?? '0';
  if (!/^\d+$/.test(value)) {
    throw new Error('SESSION_SHARE_TOKEN_MIN_IAT is misconfigured');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('SESSION_SHARE_TOKEN_MIN_IAT is misconfigured');
  }

  return parsed;
}

async function getSessionShareSecret(env: SessionShareTokenEnv): Promise<string> {
  const secret = await env.SESSION_SHARE_JWT_SECRET_PROD.get();
  if (!secret) {
    throw new Error('SESSION_SHARE_JWT_SECRET_PROD is not configured');
  }
  return secret;
}

export async function signSessionShareToken(
  env: SessionShareTokenEnv,
  params: { sessionId: string; publicId: string }
): Promise<string> {
  const secret = await getSessionShareSecret(env);
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = sessionShareTokenSigningPayloadSchema.parse({
    version: SESSION_SHARE_TOKEN_VERSION,
    sub: params.sessionId,
    jti: params.publicId,
  });

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_SHARE_TOKEN_ISSUER)
    .setAudience(SESSION_SHARE_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .sign(new TextEncoder().encode(secret));
}

export async function verifySessionShareToken(
  env: SessionShareTokenEnv,
  token: string
): Promise<SessionShareTokenPayload | null> {
  const secret = await getSessionShareSecret(env);
  const minimumIat = parseMinimumIat(env.SESSION_SHARE_TOKEN_MIN_IAT);

  try {
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: SESSION_SHARE_TOKEN_ISSUER,
      audience: SESSION_SHARE_TOKEN_AUDIENCE,
    });

    if (protectedHeader.alg !== 'HS256') {
      return null;
    }

    const parsed = sessionShareTokenPayloadSchema.parse(payload);
    return parsed.iat >= minimumIat ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveSessionShareToken(
  env: SessionShareTokenEnv,
  token: string
): Promise<ResolvedSessionShare | null> {
  const payload = await verifySessionShareToken(env, token);
  if (!payload?.jti) {
    return null;
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const rows = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      kiloUserId: cli_sessions_v2.kilo_user_id,
      title: cli_sessions_v2.title,
      ownerName: kilocode_users.google_user_name,
    })
    .from(cli_sessions_v2)
    .leftJoin(kilocode_users, eq(cli_sessions_v2.kilo_user_id, kilocode_users.id))
    .where(
      and(
        eq(cli_sessions_v2.session_id, payload.sub),
        isNotNull(cli_sessions_v2.public_id),
        eq(cli_sessions_v2.public_id, payload.jti)
      )
    )
    .limit(1);

  const row = rows[0];
  return row ?? null;
}
