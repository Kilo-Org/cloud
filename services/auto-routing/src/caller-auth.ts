import {
  AUTO_ROUTING_ORGANIZATION_HEADER,
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  type CustomRouterErrorCode,
  type CustomRouterErrorResponse,
} from '@kilocode/auto-routing-contracts';
import {
  getWorkerDb,
  kilocode_users,
  organizations,
  type OrganizationRole,
  type WorkerDb,
} from '@kilocode/db';
import { eq } from 'drizzle-orm';
import {
  extractBearerToken,
  getCachedSecret,
  verifyKiloTokenForResource,
  type KiloTokenPayload,
} from '@kilocode/worker-utils';
import {
  accountBalanceMicrodollars,
  findOrganizationMemberBalanceRow,
  findOrganizationMemberRole,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  requestOrganizationId,
} from '@kilocode/worker-utils/account-access';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import * as z from 'zod';
import { getBlacklistedDomains } from './organization-policy';

export class CustomRouterError extends Error {
  readonly code: CustomRouterErrorCode;
  // Set when a dependency was briefly unavailable and the same request can be retried.
  readonly retryAfterSeconds: number | null;

  constructor(
    code: CustomRouterErrorCode,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'CustomRouterError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

export function customRouterErrorResponse(error: CustomRouterError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } } satisfies CustomRouterErrorResponse,
    {
      status: CUSTOM_ROUTER_ERROR_HTTP_STATUS[error.code],
      ...(error.retryAfterSeconds === null
        ? {}
        : { headers: { 'retry-after': String(error.retryAfterSeconds) } }),
    }
  );
}

export type Caller = {
  userId: string;
  // The request's organization context; null for a personal request.
  organizationId: string | null;
  organizationRole: OrganizationRole | null;
  userBalanceMicrodollars: number;
  db: WorkerDb;
};

type CallerEnv = Pick<
  Env,
  'HYPERDRIVE' | 'NEXTAUTH_SECRET' | 'UPSTASH_REDIS_REST_URL' | 'UPSTASH_REDIS_REST_TOKEN'
>;

const OrganizationIdSchema = z.uuid();

async function verifyCallerToken(env: CallerEnv, token: string): Promise<KiloTokenPayload> {
  const secret = await getCachedSecret(env.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');
  let payload: KiloTokenPayload;
  try {
    // The CLI presents its gateway token, so accept exactly the audiences the gateway accepts.
    payload = await verifyKiloTokenForResource(token, secret, {
      audience: KILO_GATEWAY_AUDIENCE,
      mode: 'allow-legacy',
    });
  } catch {
    throw new CustomRouterError('unauthorized', 'Invalid token');
  }
  // Runtime-scoped tokens need a proxy attestation that only the gateway verifies.
  if (payload.runtimeAuthorization !== undefined) {
    throw new CustomRouterError('unauthorized', 'Invalid token');
  }
  return payload;
}

// Mirrors the gateway's user authentication: token, current pepper, an account outside the
// blocked email domains and not blocked, and organization membership for the organization
// context.
export async function authenticateCaller(env: CallerEnv, headers: Headers): Promise<Caller> {
  const token = extractBearerToken(headers.get('authorization'));
  if (!token) throw new CustomRouterError('unauthorized', 'Authentication required');
  const payload = await verifyCallerToken(env, token);

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const [[user], blacklistedDomains] = await Promise.all([
    db
      .select({
        api_token_pepper: kilocode_users.api_token_pepper,
        blocked_reason: kilocode_users.blocked_reason,
        google_user_email: kilocode_users.google_user_email,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        microdollars_used: kilocode_users.microdollars_used,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, payload.kiloUserId))
      .limit(1),
    getBlacklistedDomains(env),
  ]);
  if (!user || !isApiTokenPepperCurrent(user.api_token_pepper, payload.apiTokenPepper)) {
    throw new CustomRouterError('unauthorized', 'Invalid token');
  }
  if (user.blocked_reason) throw new CustomRouterError('forbidden', 'Access denied');
  // Fail closed: without a blocked-domain list this request cannot be admitted.
  if (blacklistedDomains === null) {
    throw new CustomRouterError(
      'internal_error',
      'Account checks are temporarily unavailable',
      DEPENDENCY_RETRY_AFTER_SECONDS
    );
  }
  if (isEmailBlacklistedByDomain(user.google_user_email, blacklistedDomains)) {
    throw new CustomRouterError('forbidden', 'Access denied');
  }

  const organizationId =
    requestOrganizationId(payload.organizationId, headers.get(AUTO_ROUTING_ORGANIZATION_HEADER)) ??
    null;
  let organizationRole: OrganizationRole | null = null;
  if (organizationId !== null) {
    if (!OrganizationIdSchema.safeParse(organizationId).success) {
      throw new CustomRouterError('invalid_request', 'Invalid organization ID');
    }
    organizationRole = await findOrganizationMemberRole(db, organizationId, payload.kiloUserId);
    if (organizationRole === null) {
      throw new CustomRouterError('forbidden', 'Not a member of the organization');
    }
  }

  return {
    userId: payload.kiloUserId,
    organizationId,
    organizationRole,
    userBalanceMicrodollars: accountBalanceMicrodollars(user),
    db,
  };
}

// The organization pays in an organization context, within the member's allowance; otherwise
// the user pays.
export async function loadPayerBalanceUsd(caller: Caller): Promise<number> {
  if (caller.organizationId === null) return caller.userBalanceMicrodollars / 1_000_000;
  const row = await findOrganizationMemberBalanceRow(
    caller.db,
    caller.organizationId,
    caller.userId
  );
  return row ? organizationMemberBalance(row).balanceMicrodollars / 1_000_000 : 0;
}

export async function loadOrganizationBalanceUsd(
  db: WorkerDb,
  organizationId: string
): Promise<number> {
  const [organization] = await db
    .select({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return organization ? accountBalanceMicrodollars(organization) / 1_000_000 : 0;
}
