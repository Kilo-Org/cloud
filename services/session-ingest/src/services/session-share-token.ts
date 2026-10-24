import { jwtVerify, SignJWT } from 'jose';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import {
  getSessionShareExpiresAt,
  sessionIdSchema,
  sessionShareDurationSchema,
  sessionShareOptionsSchema,
  type SessionShareOptions,
} from '@kilocode/session-ingest-contracts';
import {
  activeOrganizationJoinCondition,
  organizationMembershipJoinCondition,
  parentOrganizationJoinCondition,
  parentOrganizationMembershipJoinCondition,
  parentOrganizationsTable,
  parentOrganizationMembershipsTable,
  personalOrInheritedOrganizationCondition,
} from '@kilocode/worker-utils';
import { z } from 'zod';

import type { Env } from '../env';

export const SESSION_SHARE_TOKEN_ISSUER = 'kilo-session-ingest';
export const SESSION_SHARE_TOKEN_AUDIENCE = 'kilo-session-share';
export const SESSION_SHARE_TOKEN_VERSION = 2;

const integerSecondsSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const integerMillisecondsSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);

const commonClaims = {
  iss: z.literal(SESSION_SHARE_TOKEN_ISSUER),
  aud: z.literal(SESSION_SHARE_TOKEN_AUDIENCE),
  sub: sessionIdSchema,
  jti: z.uuid(),
  iat: integerSecondsSchema,
};

// Original links remain permanent live shares, subject to the current generation.
const legacySessionShareTokenPayloadSchema = z
  .object({ ...commonClaims, version: z.literal(1) })
  .strict();

const currentSessionShareTokenPayloadSchema = z
  .object({
    ...commonClaims,
    version: z.literal(SESSION_SHARE_TOKEN_VERSION),
    duration: sessionShareDurationSchema,
    include_new_messages: z.boolean(),
    exp: integerSecondsSchema.optional(),
    shared_at: integerMillisecondsSchema,
  })
  .strict()
  .refine(
    payload => {
      const expiresAt = getSessionShareExpiresAt(payload.duration, payload.iat);
      return expiresAt === null ? payload.exp === undefined : payload.exp === expiresAt;
    },
    {
      message: 'exp must match the selected duration',
    }
  )
  .refine(payload => Math.floor(payload.shared_at / 1000) === payload.iat, {
    message: 'shared_at must match iat',
  });

const sessionShareTokenPayloadSchema = z.discriminatedUnion('version', [
  legacySessionShareTokenPayloadSchema,
  currentSessionShareTokenPayloadSchema,
]);

export type SessionShareTokenPayload = z.infer<typeof sessionShareTokenPayloadSchema>;

export type SessionShareTokenOptions = {
  /** Injectable clock for tests and deterministic callers. */
  now?: () => Date;
};

export type ResolvedSessionShare = {
  sessionId: string;
  publicId: string;
  kiloUserId: string;
  title: string | null;
  ownerName: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  createdAt: string;
  /** Null exposes current content; otherwise only earlier ingest items are public. */
  contentCutoffMs: number | null;
};

export type SessionShareTokenEnv = {
  SESSION_SHARE_JWT_SECRET_PROD: Pick<Env['SESSION_SHARE_JWT_SECRET_PROD'], 'get'>;
  SESSION_SHARE_TOKEN_MIN_IAT: string | undefined;
  HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
};

function getNowMs(options: SessionShareTokenOptions | undefined): number {
  return (options?.now?.() ?? new Date()).getTime();
}

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
  params: { sessionId: string; publicId: string } & Partial<SessionShareOptions>,
  options: SessionShareTokenOptions = {}
): Promise<string> {
  const secret = await getSessionShareSecret(env);
  const nowMs = getNowMs(options);
  const issuedAt = Math.floor(nowMs / 1000);
  const shareOptions = sessionShareOptionsSchema.parse({
    duration: params.duration,
    include_new_messages: params.include_new_messages,
  });
  const expiresAt = getSessionShareExpiresAt(shareOptions.duration, issuedAt);
  const payload = currentSessionShareTokenPayloadSchema.parse({
    iss: SESSION_SHARE_TOKEN_ISSUER,
    aud: SESSION_SHARE_TOKEN_AUDIENCE,
    iat: issuedAt,
    version: SESSION_SHARE_TOKEN_VERSION,
    sub: params.sessionId,
    jti: params.publicId,
    shared_at: nowMs,
    ...shareOptions,
    ...(expiresAt === null ? {} : { exp: expiresAt }),
  });

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(secret));
}

export async function verifySessionShareToken(
  env: SessionShareTokenEnv,
  token: string,
  options: SessionShareTokenOptions = {}
): Promise<SessionShareTokenPayload | null> {
  const secret = await getSessionShareSecret(env);
  const minimumIat = parseMinimumIat(env.SESSION_SHARE_TOKEN_MIN_IAT);
  const nowMs = getNowMs(options);

  try {
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: SESSION_SHARE_TOKEN_ISSUER,
      audience: SESSION_SHARE_TOKEN_AUDIENCE,
      currentDate: new Date(nowMs),
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
  token: string,
  options: SessionShareTokenOptions = {}
): Promise<ResolvedSessionShare | null> {
  const payload = await verifySessionShareToken(env, token, options);
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
      gitUrl: cli_sessions_v2.git_url,
      gitBranch: cli_sessions_v2.git_branch,
      createdAt: cli_sessions_v2.created_at,
    })
    .from(cli_sessions_v2)
    .leftJoin(kilocode_users, eq(cli_sessions_v2.kilo_user_id, kilocode_users.id))
    .leftJoin(
      organization_memberships,
      organizationMembershipJoinCondition(
        cli_sessions_v2.kilo_user_id,
        cli_sessions_v2.organization_id
      )
    )
    .leftJoin(organizations, activeOrganizationJoinCondition(cli_sessions_v2.organization_id))
    .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
    .leftJoin(
      parentOrganizationMembershipsTable,
      parentOrganizationMembershipJoinCondition(cli_sessions_v2.kilo_user_id)
    )
    .where(
      and(
        eq(cli_sessions_v2.session_id, payload.sub),
        isNotNull(cli_sessions_v2.public_id),
        eq(cli_sessions_v2.public_id, payload.jti),
        personalOrInheritedOrganizationCondition(cli_sessions_v2.organization_id)
      )
    )
    .limit(1);

  const row = rows[0];
  const contentCutoffMs =
    payload.version === 1 || payload.include_new_messages ? null : payload.shared_at;
  return row ? { ...row, publicId: payload.jti, contentCutoffMs } : null;
}
