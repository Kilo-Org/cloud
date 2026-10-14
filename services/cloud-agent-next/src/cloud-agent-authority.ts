import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  CloudAgentAuthoritySchema,
  cloudAgentAuthorityProcedure,
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
  scoped: boolean,
  allocation: string | undefined
): void {
  if (scoped && allocation === 'cloudflare-shared')
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cloud Agent spawn authority requires an isolated sandbox',
    });
}

export const CLOUD_AGENT_MCP_URL = 'https://mcp.kiloapps.io/mcp';
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
  return validateCloudAgentAuthorityRequest(authority, cloudAgentAuthorityProcedure(authority), {
    ...input,
    ...(parsed.kilocodeOrganizationId === undefined
      ? {}
      : { organizationId: parsed.kilocodeOrganizationId }),
  });
}

export function assertCloudAgentParentAuthority(
  metadata: SessionMetadata | null,
  authorization: RuntimeAuthorization,
  authority: CloudAgentAuthority,
  now = Date.now()
): void {
  const scope = CloudAgentAuthoritySchema.parse(authority);
  if (
    !metadata ||
    metadata.allowSubagentSessions !== true ||
    metadata.workspace?.sandboxAllocation === 'cloudflare-shared' ||
    metadata.workspace?.sandboxRoute?.kind === 'shared' ||
    metadata.workspace?.sandboxKind === 'shared' ||
    !metadata.identity.sessionId.startsWith('workspace_') ||
    metadata.identity.sessionId !== scope.parentSessionId ||
    metadata.identity.userId !== scope.ownerId ||
    (metadata.identity.orgId ?? null) !== scope.organizationId ||
    authorization.resourceKind !== 'cloud-agent-next' ||
    authorization.resourceId !== scope.parentSessionId ||
    authorization.userId !== scope.ownerId ||
    (authorization.organizationId ?? null) !== scope.organizationId ||
    authorization.state !== 'active' ||
    authorization.id !== scope.authorizationId ||
    Date.parse(authorization.delegationExpiresAt) <= now ||
    scope.expiresAt * 1000 <= now ||
    scope.expiresAt * 1000 > Date.parse(authorization.delegationExpiresAt)
  ) {
    throw new Error('Cloud Agent parent authority denied');
  }
}

type ParentAuthorityContext = {
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<unknown>;
  secret: string;
  connectionString: string;
};

export async function issueCloudAgentMcpGrant(
  input: ParentAuthorityContext
): Promise<{ url: string; token: string; expiresAt: number } | undefined> {
  const metadata = await input.metadata();
  if (metadata?.allowSubagentSessions !== true) return undefined;
  const authorization = RuntimeAuthorizationSchema.parse(await input.authorization());
  const now = Math.floor(Date.now() / 1000);
  const scope: CloudAgentAuthority = {
    version: 1,
    ownerId: metadata.identity.userId,
    parentSessionId: metadata.identity.sessionId,
    organizationId: metadata.identity.orgId ?? null,
    authorizationId: authorization.id,
    expiresAt: Math.floor(Date.parse(authorization.delegationExpiresAt) / 1000),
  };
  assertCloudAgentParentAuthority(metadata, authorization, scope);
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
  const { token } = await signModernKiloToken({
    userId: scope.ownerId,
    pepper: verified.claims.apiTokenPepper ?? null,
    secret: input.secret,
    expiresInSeconds: scope.expiresAt - now,
    audience: 'kilo-api',
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    env: authorization.env,
    extra: {
      ...(scope.organizationId === null ? {} : { organizationId: scope.organizationId }),
      cloudAgentAuthority: scope,
    },
    now: new Date(now * 1000),
  });
  return { url: CLOUD_AGENT_MCP_URL, token, expiresAt: scope.expiresAt };
}

export async function authorizeCloudAgentChild(
  input: ParentAuthorityContext & {
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
  assertCloudAgentParentAuthority(await input.metadata(), parent, input.authority);
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
  return { token: issued.token, seal: await sealRuntimeAuthorization(child, input.secret) };
}
