import { getWorkerDb, kilocode_users, organization_memberships, organizations } from '@kilocode/db';
import { and, eq } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { signModernKiloToken, verifyKiloTokenForPolicy } from './kilo-token-policy.js';
import type { RuntimeAuthorization } from './runtime-authorization-contract.js';
import {
  RuntimeAuthorizationSchema,
  RuntimeResourceKindSchema,
} from './runtime-authorization-contract.js';
export { RuntimeAuthorizationSchema };
export type { RuntimeAuthorization };

const membershipRole = z.enum(['owner', 'admin', 'member']);
const principalSchema = z.object({
  id: z.string().min(1),
  apiTokenPepper: z.string().nullable(),
  blockedAt: z.string().nullable(),
  blockedReason: z.string().nullable(),
  isBot: z.boolean(),
});
const membershipSchema = z.object({
  id: z.string().min(1),
  role: z.string(),
  organizationDeletedAt: z.string().nullable(),
});

export type RuntimeAuthorizationPrincipal = z.infer<typeof principalSchema>;
export type RuntimeAuthorizationMembership = z.infer<typeof membershipSchema>;
export type RuntimeAuthorizationAdapters = {
  getPrincipal?: (input: {
    connectionString: string;
    userId: string;
  }) => Promise<RuntimeAuthorizationPrincipal | null>;
  getMembership?: (input: {
    connectionString: string;
    userId: string;
    organizationId: string;
  }) => Promise<RuntimeAuthorizationMembership | null>;
};

type CommonInput = {
  secret: string;
  connectionString: string;
  adapters?: RuntimeAuthorizationAdapters;
};

export class RuntimeAuthorizationRevokedError extends Error {
  constructor() {
    super('Runtime authorization has been revoked');
    this.name = 'RuntimeAuthorizationRevokedError';
  }
}

async function digest(value: string | null): Promise<string> {
  if (value === null) return 'null';
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function isBlocked(principal: RuntimeAuthorizationPrincipal): boolean {
  return principal.blockedAt !== null || principal.blockedReason !== null;
}

async function getPrincipal(
  input: CommonInput,
  userId: string
): Promise<RuntimeAuthorizationPrincipal | null> {
  if (input.adapters?.getPrincipal) {
    const principal = await input.adapters.getPrincipal({
      connectionString: input.connectionString,
      userId,
    });
    return principal === null ? null : principalSchema.parse(principal);
  }
  const db = getWorkerDb(input.connectionString);
  const [row] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
      blockedAt: kilocode_users.blocked_at,
      blockedReason: kilocode_users.blocked_reason,
      isBot: kilocode_users.is_bot,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  return row ? principalSchema.parse(row) : null;
}

async function getMembership(
  input: CommonInput,
  userId: string,
  organizationId: string
): Promise<RuntimeAuthorizationMembership | null> {
  if (input.adapters?.getMembership) {
    const membership = await input.adapters.getMembership({
      connectionString: input.connectionString,
      userId,
      organizationId,
    });
    return membership === null ? null : membershipSchema.parse(membership);
  }
  const db = getWorkerDb(input.connectionString);
  const [row] = await db
    .select({
      id: organization_memberships.id,
      role: organization_memberships.role,
      organizationDeletedAt: organizations.deleted_at,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organization_memberships.organization_id, organizations.id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId)
      )
    );
  return row ? membershipSchema.parse(row) : null;
}

async function requireBindings(
  input: CommonInput,
  record: RuntimeAuthorization
): Promise<{
  user: RuntimeAuthorizationPrincipal;
  authorizationUser: RuntimeAuthorizationPrincipal;
}> {
  const user = await getPrincipal(input, record.userId);
  const authorizationUser = await getPrincipal(input, record.authorizationUserId);
  if (
    user === null ||
    authorizationUser === null ||
    isBlocked(user) ||
    isBlocked(authorizationUser) ||
    (await digest(user.apiTokenPepper)) !== record.bindings.userPepperDigest ||
    (await digest(authorizationUser.apiTokenPepper)) !== record.bindings.authorizationPepperDigest
  )
    throw new RuntimeAuthorizationRevokedError();
  if (record.organizationId) {
    const userMembership = await getMembership(input, user.id, record.organizationId);
    const authorizationMembership = await getMembership(
      input,
      authorizationUser.id,
      record.organizationId
    );
    if (
      userMembership === null ||
      authorizationMembership === null ||
      userMembership.organizationDeletedAt !== null ||
      authorizationMembership.organizationDeletedAt !== null ||
      !membershipRole.safeParse(userMembership.role).success ||
      !membershipRole.safeParse(authorizationMembership.role).success ||
      userMembership.id !== record.bindings.userMembershipId ||
      authorizationMembership.id !== record.bindings.authorizationUserMembershipId
    )
      throw new RuntimeAuthorizationRevokedError();
  }
  return { user, authorizationUser };
}

export async function createRuntimeAuthorization(
  input: CommonInput & {
    token: string;
    resourceKind: RuntimeAuthorization['resourceKind'];
    resourceId: string;
    organizationId?: string;
  }
): Promise<{ authorization: RuntimeAuthorization; token: string; expiresAt: string }> {
  const resourceKind = RuntimeResourceKindSchema.parse(input.resourceKind);
  const resourceId = z.string().min(1).parse(input.resourceId);
  const auth = await verifyKiloTokenForPolicy(input.token, input.secret, {
    audience: resourceKind,
    mode: 'allow-legacy',
  });
  const claims = auth.claims;
  const admission = claims.runtimeAdmission;
  const soleAudience =
    typeof claims.aud === 'string'
      ? claims.aud
      : claims.aud?.length === 1
        ? claims.aud[0]
        : undefined;
  if (
    admission === undefined ||
    claims.runtimeAuthorization !== undefined ||
    soleAudience !== resourceKind ||
    claims.credentialExchange !== false ||
    claims.apiTokenPepper === undefined ||
    (admission.source === 'user' &&
      claims.tokenPurpose !== 'human-api' &&
      claims.tokenPurpose !== 'device-access') ||
    (admission.source === 'automation' && claims.tokenPurpose !== 'internal-service') ||
    claims.tokenPurpose === 'delegated-workload' ||
    claims.kiloUserId.length === 0 ||
    input.organizationId !== claims.organizationId
  )
    throw new Error('Invalid runtime admission');
  const user = await getPrincipal(input, claims.kiloUserId);
  const authorizationUser = await getPrincipal(input, admission.authorizationUserId);
  if (
    user === null ||
    authorizationUser === null ||
    isBlocked(user) ||
    isBlocked(authorizationUser) ||
    user.apiTokenPepper !== claims.apiTokenPepper ||
    authorizationUser.apiTokenPepper !== admission.authorizationPepper ||
    (user.id !== authorizationUser.id && (admission.source !== 'automation' || !user.isBot))
  )
    throw new Error('Invalid runtime admission');
  let userMembershipId: string | undefined;
  let authorizationUserMembershipId: string | undefined;
  if (input.organizationId) {
    const userMembership = await getMembership(input, user.id, input.organizationId);
    const authorizationMembership = await getMembership(
      input,
      authorizationUser.id,
      input.organizationId
    );
    if (
      userMembership === null ||
      authorizationMembership === null ||
      userMembership.organizationDeletedAt !== null ||
      authorizationMembership.organizationDeletedAt !== null ||
      !membershipRole.safeParse(userMembership.role).success ||
      !membershipRole.safeParse(authorizationMembership.role).success
    )
      throw new Error('Invalid runtime admission');
    userMembershipId = userMembership.id;
    authorizationUserMembershipId = authorizationMembership.id;
  }
  const authorization = RuntimeAuthorizationSchema.parse({
    version: 1,
    id: crypto.randomUUID(),
    resourceKind,
    resourceId,
    userId: user.id,
    authorizationUserId: authorizationUser.id,
    organizationId: input.organizationId,
    issuedAt: new Date().toISOString(),
    state: 'active',
    bindings: {
      userPepperDigest: await digest(user.apiTokenPepper),
      authorizationPepperDigest: await digest(authorizationUser.apiTokenPepper),
      userMembershipId,
      authorizationUserMembershipId,
    },
    source: {
      tokenSource: claims.tokenSource,
      botId: claims.botId,
      createdOnPlatform: claims.createdOnPlatform,
      admissionSource: admission.source,
    },
    env: claims.env,
  });
  const signed = await issueRuntimeToken(authorization, user.apiTokenPepper, input.secret);
  return { authorization, ...signed };
}

async function issueRuntimeToken(
  authorization: RuntimeAuthorization,
  pepper: string | null,
  secret: string
): Promise<{ token: string; expiresAt: string }> {
  const audiences =
    authorization.resourceKind === 'cloud-agent-next'
      ? ['kilo-api', 'kilo-gateway', 'session-ingest']
      : ['kilo-api', 'kilo-gateway'];
  return signModernKiloToken({
    userId: authorization.userId,
    pepper,
    secret,
    expiresInSeconds: 60 * 60,
    audience: audiences,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    env: authorization.env,
    extra: {
      organizationId: authorization.organizationId,
      tokenSource: authorization.source.tokenSource,
      botId: authorization.source.botId,
      createdOnPlatform: authorization.source.createdOnPlatform,
      runtimeAuthorization: {
        id: authorization.id,
        resourceKind: authorization.resourceKind,
        resourceId: authorization.resourceId,
      },
    },
  });
}

export async function renewRuntimeAuthorization(
  input: CommonInput & { authorization: RuntimeAuthorization }
): Promise<{ token: string; expiresAt: string }> {
  const authorization = RuntimeAuthorizationSchema.parse(input.authorization);
  if (authorization.state !== 'active') throw new RuntimeAuthorizationRevokedError();
  const { user } = await requireBindings(input, authorization);
  return issueRuntimeToken(authorization, user.apiTokenPepper, input.secret);
}

const sealedRecord = z.object({
  type: z.literal('runtime-authorization-record'),
  authorization: RuntimeAuthorizationSchema,
});

export async function sealRuntimeAuthorization(
  record: RuntimeAuthorization,
  secret: string
): Promise<string> {
  const authorization = RuntimeAuthorizationSchema.parse(record);
  return new SignJWT({ type: 'runtime-authorization-record', authorization })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(`${authorization.resourceKind}:runtime-authorization-record`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

export async function unsealRuntimeAuthorization(
  sealed: string,
  secret: string,
  expected: Pick<RuntimeAuthorization, 'resourceKind' | 'resourceId' | 'userId' | 'organizationId'>
): Promise<RuntimeAuthorization> {
  const { payload } = await jwtVerify(sealed, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  });
  const parsed = sealedRecord.parse(payload);
  const record = parsed.authorization;
  if (
    record.resourceKind !== expected.resourceKind ||
    record.resourceId !== expected.resourceId ||
    record.userId !== expected.userId ||
    record.organizationId !== expected.organizationId ||
    payload.aud !== `${expected.resourceKind}:runtime-authorization-record`
  )
    throw new Error('Runtime authorization seal binding mismatch');
  return record;
}
