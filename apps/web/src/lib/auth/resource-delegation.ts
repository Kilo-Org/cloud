import 'server-only';

import type { User } from '@kilocode/db/schema';
import {
  device_sessions,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, isNull, ne } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { headers as nextHeaders } from 'next/headers';
import {
  AI_ATTRIBUTION_AUDIENCE,
  CLOUD_AGENT_NEXT_AUDIENCE,
  GASTOWN_AUDIENCE,
  HTML_DEPLOY_AUDIENCE,
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  WASTELAND_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  buildModernKiloTokenPayload,
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import type { RuntimeAdmission } from '@kilocode/worker-utils/runtime-authorization-contract';
import { isSharedResourceTokenIssuanceEnabled, NEXTAUTH_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { getUserFromSessionForCredentialIssuance } from '@/lib/user/server';

const ONE_HOUR_SECONDS = 60 * 60;
const LEGACY_DEVICE_SESSION_SECONDS = ONE_HOUR_SECONDS;

export type DelegableResource = 'api' | 'gateway' | 'attribution' | 'html-deploy';
export type ControlResource = 'cloud-agent-next' | 'gastown' | 'wasteland';
type Resource = DelegableResource | ControlResource;
type CredentialKind = 'human-api' | 'device-access';

export type ResourceDelegationAuthority = {
  user: User;
  credentialKind: CredentialKind;
  expiresAt?: number;
  organizationId?: string;
  audience?: string | string[];
  tokenSource?: string;
  isModern: boolean;
  runtimeAdmission: RuntimeAdmission;
};

export class TypedResourceDelegationError extends TRPCError {
  constructor(
    public readonly status: 401 | 403 | 503,
    public readonly delegationCode: 'UNAUTHORIZED' | 'FORBIDDEN' | 'MIGRATION_UNAVAILABLE',
    message: string
  ) {
    super({
      code: status === 401 ? 'UNAUTHORIZED' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
      message,
    });
  }
}

function unauthorized(message = 'Unauthorized resource delegation request'): never {
  throw new TypedResourceDelegationError(401, 'UNAUTHORIZED', message);
}

function forbidden(message: string): never {
  throw new TypedResourceDelegationError(403, 'FORBIDDEN', message);
}

export type CreateControlTokenOptions = {
  headers?: Headers;
  organizationId?: string;
  tokenSource?: string;
  expiresIn?: number;
  legacyExpiresIn?: number;
  extra?: {
    botId?: string;
    createdOnPlatform?: string;
    isAdmin?: boolean;
    gastownAccess?: boolean;
    orgMemberships?: Array<{
      orgId: string;
      role: 'owner' | 'admin' | 'member' | 'billing_manager';
    }>;
  };
};

export type CreateDelegatedResourceTokenOptions = {
  headers?: Headers;
  organizationId?: string;
  organizationRole?: 'owner' | 'admin' | 'member';
  tokenSource?: string;
  expiresIn?: number;
};

function resourceAudience(resource: Resource): string {
  return {
    api: KILO_API_AUDIENCE,
    gateway: KILO_GATEWAY_AUDIENCE,
    attribution: AI_ATTRIBUTION_AUDIENCE,
    'html-deploy': HTML_DEPLOY_AUDIENCE,
    'cloud-agent-next': CLOUD_AGENT_NEXT_AUDIENCE,
    gastown: GASTOWN_AUDIENCE,
    wasteland: WASTELAND_AUDIENCE,
  }[resource];
}

export function isDelegableResource(value: unknown): value is DelegableResource {
  return (
    value === 'api' || value === 'gateway' || value === 'attribution' || value === 'html-deploy'
  );
}

function tokenFromHeaders(requestHeaders: Headers): string | null {
  const value = requestHeaders.get('authorization');
  if (!value || !value.toLowerCase().startsWith('bearer ')) return null;
  const token = value.slice(7).trim();
  return token || null;
}

function hasUnsafeLegacyClaims(claimNames: readonly string[]): boolean {
  const allowed = new Set([
    'version',
    'kiloUserId',
    'apiTokenPepper',
    'env',
    'iat',
    'exp',
    'deviceAuthRequestCode',
    'deviceSessionId',
  ]);
  return claimNames.some(name => !allowed.has(name));
}

async function currentUser(expectedUser: User): Promise<User> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, expectedUser.id),
  });
  if (!user || user.blocked_at || user.blocked_reason) unauthorized();
  return user;
}

async function assertActiveDeviceSession(id: string, userId: string): Promise<void> {
  const session = await db.query.device_sessions.findFirst({
    where: and(
      eq(device_sessions.id, id),
      eq(device_sessions.kilo_user_id, userId),
      isNull(device_sessions.revoked_at)
    ),
  });
  if (!session) unauthorized();
}

async function membershipsFor(userId: string) {
  return db
    .select({
      orgId: organization_memberships.organization_id,
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        ne(organization_memberships.role, 'billing_manager')
      )
    );
}

async function assertCurrentOrganizationMembership(
  userId: string,
  organizationId?: string
): Promise<void> {
  if (!organizationId) return;
  const membership = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId),
        ne(organization_memberships.role, 'billing_manager'),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);
  if (!membership[0]) unauthorized();
}

function hasRestrictedPrincipalClaims(claimNames: readonly string[]): boolean {
  const allowed = new Set([
    'version',
    'kiloUserId',
    'apiTokenPepper',
    'env',
    'aud',
    'iat',
    'exp',
    'tokenPurpose',
    'credentialExchange',
    'deviceSessionId',
  ]);
  return claimNames.some(name => !allowed.has(name));
}

export async function getResourceDelegationAuthority(
  expectedUser: User,
  options?: { headers?: Headers; organizationId?: string }
): Promise<ResourceDelegationAuthority> {
  const requestHeaders = options?.headers ?? (await nextHeaders());
  const bearer = tokenFromHeaders(requestHeaders);
  const authorizationPresent = requestHeaders.has('authorization');
  const user = await currentUser(expectedUser);
  await assertCurrentOrganizationMembership(user.id, options?.organizationId);

  if (!bearer) {
    if (authorizationPresent) {
      unauthorized();
    }
    const session = await getUserFromSessionForCredentialIssuance();
    if (!session.user || session.user.id !== expectedUser.id) {
      unauthorized();
    }
    return {
      user,
      credentialKind: 'human-api',
      isModern: false,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    };
  }

  let verified: Awaited<ReturnType<typeof verifyKiloTokenForPolicy>>;
  try {
    verified = await verifyKiloTokenForPolicy(bearer, NEXTAUTH_SECRET, {
      audience: KILO_API_AUDIENCE,
      mode: 'allow-legacy',
    });
  } catch {
    unauthorized();
  }
  const claims = verified.claims;
  if (
    verified.userId !== expectedUser.id ||
    claims.env !== process.env.NODE_ENV ||
    claims.apiTokenPepper !== user.api_token_pepper
  ) {
    unauthorized();
  }

  if (claims.tokenPurpose !== undefined) {
    if (claims.tokenPurpose !== 'human-api' && claims.tokenPurpose !== 'device-access') {
      forbidden('Delegated credentials cannot mint resource control tokens');
    }
    if (claims.aud !== KILO_API_AUDIENCE || hasRestrictedPrincipalClaims(verified.claimNames)) {
      unauthorized();
    }
    if (claims.tokenPurpose === 'device-access') {
      if (!claims.deviceSessionId) unauthorized();
      await assertActiveDeviceSession(claims.deviceSessionId, user.id);
    }
    return {
      user,
      credentialKind: claims.tokenPurpose,
      expiresAt: claims.exp,
      organizationId: claims.organizationId,
      audience: claims.aud,
      tokenSource: claims.tokenSource,
      isModern: true,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    };
  }

  if (hasUnsafeLegacyClaims(verified.claimNames)) {
    forbidden('Unsupported legacy credential context');
  }
  const isLegacyDevice = claims.deviceSessionId !== undefined;
  if (isLegacyDevice) {
    if (claims.exp - claims.iat !== LEGACY_DEVICE_SESSION_SECONDS) {
      forbidden('Unsupported legacy credential context');
    }
    await assertActiveDeviceSession(claims.deviceSessionId, user.id);
  } else if (!isKiloCredentialExchangeEligible(verified, { legacy: 'five-year-api' })) {
    forbidden('Unsupported legacy credential context');
  }
  return {
    user,
    credentialKind: isLegacyDevice ? 'device-access' : 'human-api',
    expiresAt: claims.exp,
    isModern: false,
    runtimeAdmission: {
      source: 'user',
      authorizationUserId: user.id,
      authorizationPepper: user.api_token_pepper,
    },
  };
}

export async function isModernResourceDelegationRequest(requestHeaders: Headers): Promise<boolean> {
  const bearer = tokenFromHeaders(requestHeaders);
  if (!bearer) return false;
  const verified = await verifyKiloTokenForPolicy(bearer, NEXTAUTH_SECRET, {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  });
  return verified.claims.tokenPurpose !== undefined;
}

export async function createControlTokenForRequest(
  user: User,
  resource: ControlResource,
  options?: CreateControlTokenOptions
): Promise<{ token: string; expiresAt: string; user: User; tokenSource?: string }> {
  const authority = await getResourceDelegationAuthority(user, options);
  if (authority.organizationId) {
    forbidden('Organization-scoped credentials cannot mint resource control tokens');
  }
  if (!isSharedResourceTokenIssuanceEnabled()) {
    if (authority.isModern) {
      throw new TypedResourceDelegationError(
        503,
        'MIGRATION_UNAVAILABLE',
        'Shared resource token migration is unavailable'
      );
    }
    const expiresIn =
      options?.legacyExpiresIn ??
      (resource === 'cloud-agent-next' ? TOKEN_EXPIRY.default : ONE_HOUR_SECONDS);
    const token = generateApiToken(
      authority.user,
      {
        ...options?.extra,
        tokenSource: options?.tokenSource,
        ...(resource === 'cloud-agent-next'
          ? {}
          : {
              isAdmin: options?.extra?.isAdmin === true && authority.user.is_admin,
              orgMemberships: await membershipsFor(authority.user.id),
            }),
      },
      { expiresIn }
    );
    return {
      token,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      user: authority.user,
      tokenSource: options?.tokenSource,
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const requested = options?.expiresIn ?? ONE_HOUR_SECONDS;
  const expiresIn = Math.min(
    requested,
    ONE_HOUR_SECONDS,
    authority.expiresAt ? authority.expiresAt - now : requested
  );
  if (expiresIn <= 0) unauthorized('Resource delegation authority has expired');
  const memberships =
    resource === 'cloud-agent-next' ? undefined : await membershipsFor(authority.user.id);
  const payload = buildModernKiloTokenPayload({
    userId: authority.user.id,
    pepper: authority.user.api_token_pepper,
    env: process.env.NODE_ENV,
    audience: resourceAudience(resource),
    issuedAt: now,
    expiresAt: now + expiresIn,
    tokenPurpose: authority.credentialKind,
    credentialExchange: false,
    extra: {
      organizationId: options?.organizationId ?? authority.organizationId,
      tokenSource: options?.tokenSource ?? authority.tokenSource,
      botId: options?.extra?.botId,
      createdOnPlatform: options?.extra?.createdOnPlatform,
      isAdmin: options?.extra?.isAdmin === true && authority.user.is_admin,
      gastownAccess: options?.extra?.gastownAccess,
      orgMemberships: memberships,
      ...(resource === 'wasteland' ? {} : { runtimeAdmission: authority.runtimeAdmission }),
    },
  });
  const token = jwt.sign(payload, NEXTAUTH_SECRET, { algorithm: 'HS256' });
  return {
    token,
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    user: authority.user,
    tokenSource: options?.tokenSource ?? authority.tokenSource,
  };
}

export async function createDelegatedResourceToken(
  user: User,
  resource: DelegableResource,
  options?: CreateDelegatedResourceTokenOptions
): Promise<{ token: string; expiresAt: string; user: User; tokenSource?: string }> {
  const authority = await getResourceDelegationAuthority(user, options);
  if (authority.organizationId && authority.organizationId !== options?.organizationId) {
    forbidden('Scoped credentials cannot mint tokens for another organization');
  }
  if (authority.organizationId && authority.audience !== resourceAudience(resource)) {
    forbidden('Scoped credentials cannot broaden their resource audience');
  }
  if (!isSharedResourceTokenIssuanceEnabled()) {
    throw new TypedResourceDelegationError(
      503,
      'MIGRATION_UNAVAILABLE',
      'Shared resource token migration is unavailable'
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const requested = options?.expiresIn ?? 15 * 60;
  const expiresIn = Math.min(
    requested,
    15 * 60,
    authority.expiresAt ? authority.expiresAt - now : requested
  );
  if (expiresIn <= 0) unauthorized('Resource delegation authority has expired');
  const payload = buildModernKiloTokenPayload({
    userId: authority.user.id,
    pepper: authority.user.api_token_pepper,
    env: process.env.NODE_ENV,
    audience: resourceAudience(resource),
    issuedAt: now,
    expiresAt: now + expiresIn,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    extra: {
      organizationId: options?.organizationId ?? authority.organizationId,
      organizationRole: options?.organizationRole,
      tokenSource: options?.tokenSource ?? authority.tokenSource,
    },
  });
  return {
    token: jwt.sign(payload, NEXTAUTH_SECRET, { algorithm: 'HS256' }),
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    user: authority.user,
    tokenSource: options?.tokenSource ?? authority.tokenSource,
  };
}
