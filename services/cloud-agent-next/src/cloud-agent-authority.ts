import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
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
import { backendUrlForSandbox } from './kilo/kilo-targets.js';
import {
  isLegacySharedSandboxWorkspace,
  type SessionMetadata,
} from './persistence/session-metadata.js';

export const CLOUD_AGENT_PARENT_AUTHORITY_DENIED = 'Cloud Agent parent authority denied';

export const CLOUD_AGENT_MCP_URL = 'https://mcp.kiloapps.io/mcp';

export type WorkspaceMcpBinding = {
  worktreeId: string;
  ownerId: string;
  organizationId: string | null;
};

const WORKTREE_ID_PREFIX = 'worktree_';
const WORKSPACE_SESSION_ID_PREFIX = 'workspace_';
const workspaceSessionIdSchema = z.templateLiteral([WORKSPACE_SESSION_ID_PREFIX, z.uuid()]);

// Worktree creation uses the initial root's UUID. Never elect a replacement sibling.
export function workspaceMcpAnchorSessionId(
  scopeId: string | null | undefined,
  sessionId: string
): string | undefined {
  if (scopeId === null || scopeId === undefined || !scopeId.startsWith(WORKTREE_ID_PREFIX)) {
    return sessionId;
  }
  const parsed = workspaceSessionIdSchema.safeParse(
    `${WORKSPACE_SESSION_ID_PREFIX}${scopeId.slice(WORKTREE_ID_PREFIX.length)}`
  );
  return parsed.success ? parsed.data : undefined;
}

export function isWorkspaceAnchorMetadata(metadata: SessionMetadata | null): boolean {
  if (metadata === null) return false;
  const worktreeId = metadata.workspace?.worktreeId;
  if (worktreeId === undefined) return true;
  return (
    worktreeId ===
    `${WORKTREE_ID_PREFIX}${metadata.identity.sessionId.slice(WORKSPACE_SESSION_ID_PREFIX.length)}`
  );
}

function matchesWorkspaceMcpBinding(
  metadata: SessionMetadata | null,
  workspace: WorkspaceMcpBinding | undefined
): boolean {
  return (
    workspace === undefined ||
    (metadata !== null &&
      metadata.workspace?.worktreeId === workspace.worktreeId &&
      metadata.identity.userId === workspace.ownerId &&
      (metadata.identity.orgId ?? null) === workspace.organizationId)
  );
}

export function resolveCloudAgentMcpUrl(override?: string): string {
  if (!override) return CLOUD_AGENT_MCP_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return CLOUD_AGENT_MCP_URL;
    return backendUrlForSandbox(override);
  } catch {
    return CLOUD_AGENT_MCP_URL;
  }
}
const workerPreparationMetadataSchema = z
  .object({
    platform: z.literal('github').optional(),
    createdOnPlatform: z.enum(['cloud-agent', 'cloud-agent-web']).optional(),
    githubAccessPurpose: z.enum(['agent', 'workflow']).optional(),
    clientProvenance: z.enum(['browser', 'mobile']).optional(),
    kilocodeOrganizationId: z.string().optional(),
    githubIntegrationId: z.uuid().optional(),
    // These fields are resolved by the web app, not accepted by the scoped MCP tool.
    stackOnWorktreeId: z.never().optional(),
    baseBranch: z.string().min(1).max(256).optional(),
    baseSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
      .optional(),
    parentWorktreeId: cloudAgentWorktreeIdSchema.optional(),
  })
  .passthrough();

export function validateScopedWorkerPreparation(authority: CloudAgentAuthority, rawInput: unknown) {
  const parsed = workerPreparationMetadataSchema.parse(rawInput);
  const hasBase = parsed.baseBranch !== undefined || parsed.baseSha !== undefined;
  if (
    parsed.parentWorktreeId === undefined
      ? hasBase
      : parsed.baseBranch === undefined || parsed.baseSha === undefined
  ) {
    throw new Error('Stacked preparation requires a parent worktree, base branch, and base commit');
  }
  const input = { ...parsed };
  for (const key of Object.keys(workerPreparationMetadataSchema.shape)) delete input[key];
  return validateCloudAgentAuthorityRequest(authority, cloudAgentAuthorityProcedure(authority), {
    ...input,
    ...(parsed.parentWorktreeId === undefined
      ? {}
      : { stackOnWorktreeId: parsed.parentWorktreeId }),
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
    !isWorkspaceAnchorMetadata(metadata) ||
    metadata.allowSubagentSessions !== true ||
    isLegacySharedSandboxWorkspace(metadata.workspace) ||
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
    throw new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  }
}

type ParentAuthorityContext = {
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<unknown>;
  secret: string;
  connectionString: string;
  mcpUrl?: string;
};

export async function issueCloudAgentMcpGrant(
  input: ParentAuthorityContext & { workspace?: WorkspaceMcpBinding }
): Promise<{ url: string; token: string; expiresAt: number } | undefined> {
  const metadata = await input.metadata();
  if (metadata?.allowSubagentSessions !== true) return undefined;
  if (!isWorkspaceAnchorMetadata(metadata)) return undefined;
  if (!matchesWorkspaceMcpBinding(metadata, input.workspace)) return undefined;
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
  const currentMetadata = await input.metadata();
  assertCloudAgentParentAuthority(currentMetadata, current, scope);
  if (!matchesWorkspaceMcpBinding(currentMetadata, input.workspace)) return undefined;
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
  return { url: resolveCloudAgentMcpUrl(input.mcpUrl), token, expiresAt: scope.expiresAt };
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

/**
 * Mint the runtime authorization for a new sibling chat in the parent's
 * workspace. Unlike a child, the sibling shares the parent's worktree and has
 * no spawn lineage, so it is a workspace root with its own authorization.
 */
export async function authorizeCloudAgentWorkspaceSibling(input: {
  parentSessionId: string;
  siblingSessionId: string;
  secret: string;
  connectionString: string;
  metadata: () => Promise<SessionMetadata | null>;
  authorization: () => Promise<unknown>;
}): Promise<{ token: string; seal: string }> {
  if (
    !input.siblingSessionId.startsWith('workspace_') ||
    input.siblingSessionId === input.parentSessionId
  ) {
    throw new Error('Cloud Agent sibling requires an independent workspace session');
  }
  const metadata = await input.metadata();
  if (metadata?.identity.sessionId !== input.parentSessionId) {
    throw new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  }
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
  if (scope.expiresAt <= now) throw new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  assertCloudAgentParentAuthority(metadata, authorization, scope);
  const sibling = RuntimeAuthorizationSchema.parse({
    ...authorization,
    id: crypto.randomUUID(),
    resourceId: input.siblingSessionId,
    issuedAt: new Date().toISOString(),
  });
  const issued = await renewRuntimeAuthorization({
    authorization: sibling,
    secret: input.secret,
    connectionString: input.connectionString,
  });
  const current = RuntimeAuthorizationSchema.parse(await input.authorization());
  const currentMetadata = await input.metadata();
  if (currentMetadata?.identity.sessionId !== input.parentSessionId) {
    throw new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  }
  assertCloudAgentParentAuthority(currentMetadata, current, scope);
  return { token: issued.token, seal: await sealRuntimeAuthorization(sibling, input.secret) };
}
