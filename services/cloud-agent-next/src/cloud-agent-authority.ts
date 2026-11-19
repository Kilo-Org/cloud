import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import {
  CloudAgentAuthoritySchema,
  cloudAgentAuthorityProcedure,
  validateCloudAgentAuthorityRequest,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { egressModeSchema } from '@kilocode/worker-utils/egress-allowlist';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import { backendUrlForSandbox } from './kilo/kilo-targets.js';
import {
  isLegacySharedSandboxWorkspace,
  type SessionMetadata,
} from './persistence/session-metadata.js';

export const CLOUD_AGENT_PARENT_AUTHORITY_DENIED = 'Cloud Agent parent authority denied';

export const CLOUD_AGENT_MCP_URL = 'https://mcp.kiloapps.io/mcp';

const WORKTREE_ID_PREFIX = 'worktree_';
const WORKSPACE_SESSION_ID_PREFIX = 'workspace_';
export const workspaceSessionIdSchema = z.templateLiteral([WORKSPACE_SESSION_ID_PREFIX, z.uuid()]);

/** The workspace a route or chat belongs to, as the Sandbox DO sees it. */
export type WorkspaceMcpBinding = {
  workspaceSessionId: string;
  worktreeId: string | null;
  ownerId: string;
  organizationId: string | null;
};

/**
 * The canonical workspace ID. A worktree is named after the UUID of the chat
 * that created it, so `worktree_<uuid>` maps to `workspace_<uuid>` for the
 * whole workspace's life, including after that chat is deleted. A session
 * without a worktree is its own workspace. The ID names the workspace; it never
 * selects a chat whose authorization grants anything.
 */
export function workspaceSessionIdForScope(
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

export function workspaceSessionIdForMetadata(metadata: SessionMetadata): string | undefined {
  return workspaceSessionIdForScope(metadata.workspace?.worktreeId, metadata.identity.sessionId);
}

/** Whether this chat created its workspace: the only chat a workspace record is seeded from. */
export function isWorkspaceAnchorMetadata(metadata: SessionMetadata | null): boolean {
  if (metadata === null) return false;
  return workspaceSessionIdForMetadata(metadata) === metadata.identity.sessionId;
}

export const workspaceEgressSchema = z
  .object({
    egressMode: egressModeSchema,
    egressAllowlist: z.array(z.string()).optional(),
    egressAudit: z.literal(true).optional(),
  })
  .strict();

/**
 * The workspace's own Cloud Agent authority. It is bound to the canonical
 * workspace ID, owner and organization, and carries its own runtime
 * delegation and revocation state, independent of any chat's authorization.
 */
export const WorkspaceAuthorityRecordSchema = z
  .object({
    version: z.literal(1),
    workspaceSessionId: workspaceSessionIdSchema,
    worktreeId: cloudAgentWorktreeIdSchema.nullable(),
    ownerId: z.string().min(1),
    organizationId: z.string().min(1).nullable(),
    createdOnPlatform: z.string().optional(),
    egress: workspaceEgressSchema.optional(),
    authorization: RuntimeAuthorizationSchema,
    establishedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.authorization.resourceKind !== 'cloud-agent-next' ||
      record.authorization.resourceId !== record.workspaceSessionId ||
      record.authorization.userId !== record.ownerId ||
      (record.authorization.organizationId ?? null) !== record.organizationId ||
      (record.worktreeId !== null &&
        workspaceSessionIdForScope(record.worktreeId, record.workspaceSessionId) !==
          record.workspaceSessionId)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Workspace authority binding mismatch' });
    }
  });

export type WorkspaceAuthorityRecord = z.infer<typeof WorkspaceAuthorityRecordSchema>;

export type WorkspaceChildEntry = {
  cloudAgentSessionId: string;
  initialMessageId?: string;
  worktreeId?: string;
};

/** What the creating chat hands its workspace once: authorization and legacy child hints. */
export type WorkspaceAuthoritySeed = {
  metadata: SessionMetadata;
  authorization: unknown;
  children: WorkspaceChildEntry[];
};
export type WorkspaceEgress = z.infer<typeof workspaceEgressSchema>;

/** The network policy a workspace records from the chat that created it. */
export function workspaceEgressFromMetadata(
  metadata: SessionMetadata
): WorkspaceEgress | undefined {
  const workspace = metadata.workspace;
  if (workspace?.egressMode !== 'allowlist' && workspace?.egressAudit !== true) return undefined;
  return {
    egressMode: workspace.egressMode ?? 'unrestricted',
    ...(workspace.egressMode === 'allowlist'
      ? { egressAllowlist: workspace.egressAllowlist ?? [] }
      : {}),
    ...(workspace.egressAudit === true ? { egressAudit: true as const } : {}),
  };
}

/**
 * The record a workspace adopts once from the chat that created it. The
 * authorization is copied as stored, including an expired or revoked state, so
 * adoption never restores anything the creating chat had lost. Adopting it
 * keeps grants issued before the workspace owned its authority valid until
 * their own expiry.
 */
export function workspaceAuthorityFromAnchor(
  seed: { metadata: SessionMetadata; authorization: unknown },
  now: number
): WorkspaceAuthorityRecord | undefined {
  const { metadata } = seed;
  if (
    !isWorkspaceAnchorMetadata(metadata) ||
    metadata.allowSubagentSessions !== true ||
    isLegacySharedSandboxWorkspace(metadata.workspace)
  ) {
    return undefined;
  }
  const authorization = RuntimeAuthorizationSchema.safeParse(seed.authorization);
  if (!authorization.success) return undefined;
  const record = WorkspaceAuthorityRecordSchema.safeParse({
    version: 1,
    workspaceSessionId: metadata.identity.sessionId,
    worktreeId: metadata.workspace?.worktreeId ?? null,
    ownerId: metadata.identity.userId,
    organizationId: metadata.identity.orgId ?? null,
    ...(metadata.identity.createdOnPlatform === undefined
      ? {}
      : { createdOnPlatform: metadata.identity.createdOnPlatform }),
    ...(workspaceEgressFromMetadata(metadata) === undefined
      ? {}
      : { egress: workspaceEgressFromMetadata(metadata) }),
    authorization: authorization.data,
    establishedAt: now,
  });
  return record.success ? record.data : undefined;
}

export type WorkspaceAuthorityUnavailableReason =
  | 'stored_authorization_revoked'
  | 'delegation_expired';

export function workspaceAuthorityUnavailableReason(
  record: WorkspaceAuthorityRecord,
  now: number
): WorkspaceAuthorityUnavailableReason | undefined {
  if (record.authorization.state !== 'active') return 'stored_authorization_revoked';
  // Credentials carry whole seconds, so a delegation in its last second is already spent.
  if (workspaceAuthorityScope(record).expiresAt * 1000 <= now) return 'delegation_expired';
  return undefined;
}

export function workspaceAuthorityScope(record: WorkspaceAuthorityRecord): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: record.ownerId,
    parentSessionId: record.workspaceSessionId,
    organizationId: record.organizationId,
    authorizationId: record.authorization.id,
    expiresAt: Math.floor(Date.parse(record.authorization.delegationExpiresAt) / 1000),
  };
}

function hasWorkspaceAuthorityMismatch(
  record: WorkspaceAuthorityRecord,
  scope: CloudAgentAuthority
): boolean {
  return (
    scope.parentSessionId !== record.workspaceSessionId ||
    scope.ownerId !== record.ownerId ||
    scope.organizationId !== record.organizationId ||
    scope.authorizationId !== record.authorization.id ||
    scope.expiresAt * 1000 > Date.parse(record.authorization.delegationExpiresAt)
  );
}

/**
 * The stored part of every authority check: the presented authority names this
 * workspace's current authorization, which is active and unexpired. Live
 * owner, organization and device-session checks follow in the caller.
 */
export function assertWorkspaceAuthority(
  record: WorkspaceAuthorityRecord | undefined,
  authority: unknown,
  now = Date.now()
): asserts record is WorkspaceAuthorityRecord {
  const scope = CloudAgentAuthoritySchema.safeParse(authority);
  if (
    record === undefined ||
    !scope.success ||
    hasWorkspaceAuthorityMismatch(record, scope.data) ||
    workspaceAuthorityUnavailableReason(record, now) !== undefined ||
    scope.data.expiresAt * 1000 <= now
  ) {
    throw new Error(CLOUD_AGENT_PARENT_AUTHORITY_DENIED);
  }
}

export function matchesWorkspaceMcpBinding(
  record: WorkspaceAuthorityRecord,
  binding: WorkspaceMcpBinding
): boolean {
  return (
    binding.workspaceSessionId === record.workspaceSessionId &&
    binding.worktreeId === record.worktreeId &&
    binding.ownerId === record.ownerId &&
    binding.organizationId === record.organizationId
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

/** Signs the workspace MCP credential. Its lifetime ends with the workspace delegation. */
export async function signWorkspaceMcpGrant(input: {
  record: WorkspaceAuthorityRecord;
  pepper: string | null;
  secret: string;
  mcpUrl?: string;
  now: number;
}): Promise<{ url: string; token: string; expiresAt: number }> {
  const scope = workspaceAuthorityScope(input.record);
  const issuedAt = Math.floor(input.now / 1000);
  const { token } = await signModernKiloToken({
    userId: scope.ownerId,
    pepper: input.pepper,
    secret: input.secret,
    expiresInSeconds: scope.expiresAt - issuedAt,
    audience: 'kilo-api',
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    env: input.record.authorization.env,
    extra: {
      ...(scope.organizationId === null ? {} : { organizationId: scope.organizationId }),
      cloudAgentAuthority: scope,
    },
    now: new Date(issuedAt * 1000),
  });
  return { url: resolveCloudAgentMcpUrl(input.mcpUrl), token, expiresAt: scope.expiresAt };
}

/**
 * A runtime authorization for a direct child or a new chat in this workspace.
 * It inherits the workspace's bindings and never outlives its delegation.
 */
export function deriveWorkspaceRuntimeAuthorization(
  record: WorkspaceAuthorityRecord,
  resourceId: string,
  now: number
): RuntimeAuthorization {
  if (
    !resourceId.startsWith(WORKSPACE_SESSION_ID_PREFIX) ||
    resourceId === record.workspaceSessionId
  ) {
    throw new Error('Cloud Agent delegation requires an independent workspace session');
  }
  return RuntimeAuthorizationSchema.parse({
    ...record.authorization,
    id: crypto.randomUUID(),
    resourceId,
    issuedAt: new Date(now).toISOString(),
  });
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
