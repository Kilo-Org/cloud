import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  CloudAgentAuthoritySchema,
  CloudAgentSpawnPolicySchema,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import {
  renewRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import {
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  signModernKiloToken,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import type { SessionMetadata } from './persistence/session-metadata.js';

export function assertCloudAgentIsolatedAllocation(
  spawn: SessionMetadata['cloudAgentSpawn'],
  allocation: string | undefined
): void {
  if (spawn && allocation === 'cloudflare-shared')
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cloud Agent spawn authority requires an isolated sandbox',
    });
}

export const CLOUD_AGENT_MCP_URL = 'https://mcp.kiloapps.io/mcp';
export const CLOUD_AGENT_MCP_GRANT_KEY = 'cloud_agent_mcp_grant';
const grantSchema = z
  .object({
    authorizationId: z.string().uuid(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    token: z.string().optional(),
  })
  .strict();

const workerPreparationMetadataSchema = z
  .object({
    platform: z.literal('github').optional(),
    createdOnPlatform: z.enum(['cloud-agent', 'cloud-agent-web']).optional(),
    githubAccessPurpose: z.enum(['agent', 'workflow']).optional(),
    clientProvenance: z.enum(['browser', 'mobile']).optional(),
    kilocodeOrganizationId: z.string().optional(),
  })
  .passthrough();

export function validateScopedWorkerPreparation(authority: CloudAgentAuthority, rawInput: unknown) {
  const parsed = workerPreparationMetadataSchema.parse(rawInput);
  const input = { ...parsed };
  for (const key of Object.keys(workerPreparationMetadataSchema.shape)) delete input[key];
  return validateCloudAgentAuthorityRequest(
    authority,
    authority.organizationId === null
      ? 'cloudAgentNext.prepareSession'
      : 'organizations.cloudAgentNext.prepareSession',
    {
      ...input,
      ...(parsed.kilocodeOrganizationId === undefined
        ? {}
        : { organizationId: parsed.kilocodeOrganizationId }),
    }
  );
}

export function validateSpawnOptInPreparation(rawInput: unknown): void {
  const raw = z.record(z.string(), z.unknown()).parse(rawInput);
  if (raw.cloudAgentSpawn === undefined) return;
  const policy = CloudAgentSpawnPolicySchema.parse(raw.cloudAgentSpawn);
  const input = { ...raw };
  delete input.cloudAgentSpawn;
  delete input.createdOnPlatform;
  const organizationId = z.string().optional().parse(raw.kilocodeOrganizationId) ?? null;
  const procedure =
    organizationId === null
      ? 'cloudAgentNext.prepareSession'
      : 'organizations.cloudAgentNext.prepareSession';
  if (
    policy.procedures.some(value => value !== procedure) ||
    raw.parentCloudAgentSessionId !== undefined
  ) {
    throw new Error('Cloud Agent spawn policy has an invalid ownership boundary');
  }
  validateScopedWorkerPreparation(
    {
      version: 1,
      ownerId: 'parent',
      parentSessionId: 'parent',
      organizationId,
      procedures: [procedure],
      repositories: [z.string().parse(input.githubRepo)],
      models: [z.string().parse(input.model)],
      remainingDepth: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    },
    { ...input, parentCloudAgentSessionId: 'parent' }
  );
}

export function assertCloudAgentIssuedGrant(
  stored: unknown,
  authorization: RuntimeAuthorization,
  authority: CloudAgentAuthority
): void {
  const grant = grantSchema.parse(stored);
  if (
    grant.authorizationId !== authorization.id ||
    grant.token === undefined ||
    grant.expiresAt < authority.expiresAt
  ) {
    throw new Error('Cloud Agent authority grant is no longer current');
  }
}

export function assertCloudAgentParentAuthority(
  metadata: SessionMetadata | null,
  authorization: RuntimeAuthorization,
  authority: CloudAgentAuthority,
  now = Date.now()
): void {
  const scope = CloudAgentAuthoritySchema.parse(authority);
  const policy = metadata?.cloudAgentSpawn?.policy;
  if (
    !metadata ||
    !policy ||
    metadata.workspace?.sandboxAllocation === 'cloudflare-shared' ||
    metadata.workspace?.sandboxRoute?.kind === 'shared' ||
    metadata.workspace?.sandboxKind === 'shared' ||
    metadata.cloudAgentSpawn?.parentSessionId !== undefined ||
    !metadata.identity.sessionId.startsWith('workspace_') ||
    metadata.identity.sessionId !== scope.parentSessionId ||
    metadata.identity.userId !== scope.ownerId ||
    (metadata.identity.orgId ?? null) !== scope.organizationId ||
    authorization.resourceKind !== 'cloud-agent-next' ||
    authorization.resourceId !== scope.parentSessionId ||
    authorization.userId !== scope.ownerId ||
    (authorization.organizationId ?? null) !== scope.organizationId ||
    authorization.state !== 'active' ||
    Date.parse(authorization.delegationExpiresAt) <= now ||
    scope.expiresAt * 1000 <= now ||
    scope.expiresAt * 1000 > Date.parse(authorization.delegationExpiresAt) ||
    scope.procedures.some(value => !policy.procedures.includes(value)) ||
    scope.repositories.some(value => !policy.repositories.includes(value)) ||
    scope.models.some(value => !policy.models.includes(value)) ||
    policy.remainingDepth !== scope.remainingDepth
  ) {
    throw new Error('Cloud Agent parent authority denied');
  }
}

type ParentAuthorityContext = {
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<unknown>;
  live: () => Promise<boolean>;
  secret: string;
  connectionString: string;
};

export async function issueCloudAgentMcpGrant(
  input: ParentAuthorityContext & {
    storage: Pick<DurableObjectStorage, 'get' | 'put'>;
  }
): Promise<{ url: string; token: string; expiresAt: number } | undefined> {
  const metadata = await input.metadata();
  const policy = metadata?.cloudAgentSpawn?.policy;
  if (!policy) return undefined;
  const stored = await input.storage.get<unknown>(CLOUD_AGENT_MCP_GRANT_KEY);
  const existing = stored === undefined ? undefined : grantSchema.parse(stored);
  if (existing?.token !== undefined) {
    return { url: CLOUD_AGENT_MCP_URL, token: existing.token, expiresAt: existing.expiresAt };
  }
  const authorization = RuntimeAuthorizationSchema.parse(await input.authorization());
  const now = Math.floor(Date.now() / 1000);
  const grant =
    existing === undefined
      ? {
          authorizationId: authorization.id,
          issuedAt: now,
          expiresAt: Math.min(
            now + 900,
            Math.floor(Date.parse(authorization.delegationExpiresAt) / 1000)
          ),
        }
      : existing;
  if (existing === undefined) await input.storage.put(CLOUD_AGENT_MCP_GRANT_KEY, grant);
  const scope: CloudAgentAuthority = {
    ...policy,
    version: 1,
    ownerId: metadata.identity.userId,
    parentSessionId: metadata.identity.sessionId,
    organizationId: metadata.identity.orgId ?? null,
    expiresAt: grant.expiresAt,
  };
  assertCloudAgentParentAuthority(metadata, authorization, scope);
  if (grant.authorizationId !== authorization.id || !(await input.live())) {
    throw new Error('Cloud Agent MCP authority unavailable');
  }
  const renewed = await renewRuntimeAuthorization({
    authorization,
    secret: input.secret,
    connectionString: input.connectionString,
  });
  const verified = await verifyKiloTokenForPolicy(renewed.token, input.secret, {
    audience: 'kilo-api',
    mode: 'required',
  });
  const current = RuntimeAuthorizationSchema.parse(await input.authorization());
  assertCloudAgentParentAuthority(await input.metadata(), current, scope);
  if (current.id !== authorization.id) throw new Error('Cloud Agent parent authority changed');
  const { token } = await signModernKiloToken({
    userId: scope.ownerId,
    pepper: verified.claims.apiTokenPepper ?? null,
    secret: input.secret,
    expiresInSeconds: scope.expiresAt - grant.issuedAt,
    audience: 'kilo-api',
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    env: authorization.env,
    extra: {
      ...(scope.organizationId === null ? {} : { organizationId: scope.organizationId }),
      cloudAgentAuthority: scope,
    },
    now: new Date(grant.issuedAt * 1000),
  });
  await input.storage.put(CLOUD_AGENT_MCP_GRANT_KEY, { ...grant, token });
  return { url: CLOUD_AGENT_MCP_URL, token, expiresAt: scope.expiresAt };
}

export async function authorizeCloudAgentChild(
  input: ParentAuthorityContext & {
    grant: () => Promise<unknown>;
    authority: CloudAgentAuthority;
    childSessionId: string;
  }
): Promise<{ token: string; seal: string }> {
  if (
    !input.childSessionId.startsWith('workspace_') ||
    input.childSessionId === input.authority.parentSessionId
  ) {
    throw new Error('Cloud Agent child requires an independent workspace session');
  }
  const parent = RuntimeAuthorizationSchema.parse(await input.authorization());
  assertCloudAgentIssuedGrant(await input.grant(), parent, input.authority);
  assertCloudAgentParentAuthority(await input.metadata(), parent, input.authority);
  if (!(await input.live())) throw new Error('Cloud Agent parent is not live');
  const child = RuntimeAuthorizationSchema.parse({
    ...parent,
    id: crypto.randomUUID(),
    resourceId: input.childSessionId,
    issuedAt: new Date().toISOString(),
  });
  const issued = await renewRuntimeAuthorization({
    authorization: child,
    secret: input.secret,
    connectionString: input.connectionString,
  });
  const current = RuntimeAuthorizationSchema.parse(await input.authorization());
  assertCloudAgentParentAuthority(await input.metadata(), current, input.authority);
  if (current.id !== parent.id || !(await input.live()))
    throw new Error('Cloud Agent parent authority changed');
  return { token: issued.token, seal: await sealRuntimeAuthorization(child, input.secret) };
}
