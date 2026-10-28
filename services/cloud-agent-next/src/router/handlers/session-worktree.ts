import { VERCEL_BYOC_REQUIRED_MESSAGE } from '../../byoc/vercel-owner.js';
import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  admitOperation,
  markReconcilePending,
  recordOperationProgress,
  settleOperation,
} from '@kilocode/db/operation-ledger';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  type OperationLedgerRow,
} from '@kilocode/db/schema';
import {
  clientKiloSessionIdSchema,
  cloudAgentWorktreeIdSchema,
  sessionIdSchema as kiloSessionIdSchema,
  WORKSPACE_DELETING,
  WORKSPACE_IDENTITY_CONFLICT,
  WORKSPACE_REQUIRES_ROOT_SESSION,
  WORKSPACE_UNAVAILABLE,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { normalizeGitUrl, sha256Hex } from '@kilocode/worker-utils';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { sandboxAllocationSchema } from '@kilocode/worker-utils/sandbox-allocation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getPgDb } from '../../db/pg.js';
import {
  CurrentSessionMetadataSchema,
  getSandboxProviderBinding,
  type SessionMetadata,
} from '../../persistence/session-metadata.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import { sameSandboxProviderBinding } from '../../sandbox-provider-binding.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { generateSessionId } from '../../session-identity.js';
import { buildControlPlaneSandboxSelection } from '../../session/control-plane-session-input.js';
import { createMessageId } from '../../session/message-id.js';
import { preflightAndQueuePromptMessage } from '../../session/queue-message.js';
import type { MessageResultRPCResponse } from '../../session/message-result.js';
import {
  assertSessionOperationIdentity,
  assertRuntimeIsolationAdmission,
  SESSION_CREATE_INTENT_FINGERPRINT_KEY,
} from '../../session/session-registration.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { generateKiloSessionId } from '../../utils/kilo-session-id.js';
import { isInteractiveSessionOrigin } from '../../shared/control-plane-permission.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { protectedProcedure } from '../auth.js';
import { resolveSecret } from '../../auth.js';
import {
  AttachmentsSchema,
  Limits,
  MessageIdSchema,
  ModeSlugSchema,
  modelIdSchema,
} from '../schemas.js';
import { assertOrganizationMembership } from './organization-membership.js';
import { assertModeAvailableForProfile } from './session-creation-preflight.js';

const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

export const CreateWorktreeChatInput = z
  .object({
    sourceKiloSessionId: kiloSessionIdSchema,
    sourceCloudAgentSessionId: workspaceSessionIdSchema,
    operationKey: z.uuid(),
    /** Client-proposed id, so the client can show the chat before this call returns. */
    kiloSessionId: clientKiloSessionIdSchema.optional(),
    kilocodeOrganizationId: z.uuid().optional(),
    clientProvenance: z.literal('browser'),
  })
  .strict();

export const CreateWorktreeChatOutput = z
  .object({
    cloudAgentSessionId: workspaceSessionIdSchema,
    kiloSessionId: kiloSessionIdSchema,
    worktreeId: cloudAgentWorktreeIdSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

/**
 * Add another root chat to an existing hosted workspace.
 *
 * The workspace supplies repository, ref, profile, environment, sandbox and
 * clone. The caller supplies only session-scoped agent/model/prompt and a
 * client operation key; no workspace-wide field is accepted.
 */
export const CreateHostedWorkspaceSessionInput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    operationKey: z.uuid(),
    clientProvenance: z.literal('agent-manager'),
    message: z
      .object({
        prompt: z.string().min(1).max(Limits.MAX_PROMPT_LENGTH),
        attachments: AttachmentsSchema.optional(),
        id: MessageIdSchema.optional(),
      })
      .strict(),
    agent: z
      .object({
        mode: ModeSlugSchema,
        model: modelIdSchema,
        variant: z
          .string()
          .max(50)
          .regex(/^[a-zA-Z]+$/)
          .optional(),
      })
      .strict(),
    kilocodeOrganizationId: z.uuid().optional(),
    kiloSessionId: clientKiloSessionIdSchema.optional(),
  })
  .strict();

export const CreateHostedWorkspaceSessionOutput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    cloudAgentSessionId: workspaceSessionIdSchema,
    kiloSessionId: kiloSessionIdSchema,
    messageId: MessageIdSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

const ownershipRowSchema = z
  .object({
    kiloSessionId: kiloSessionIdSchema,
    cloudAgentSessionId: workspaceSessionIdSchema,
    userId: z.string().min(1),
    organizationId: z.uuid().nullable(),
    worktreeId: cloudAgentWorktreeIdSchema.nullable(),
    createdOnPlatform: z.string().min(1),
    parentSessionId: z.string().nullable(),
    cloudAgentSessionScopeId: workspaceSessionIdSchema.nullable(),
    gitUrl: z.string().nullable(),
    gitBranch: z.string().nullable().optional(),
    profileId: z.uuid().nullable().optional(),
  })
  .strict();

const operationProgressSchema = CreateWorktreeChatOutput.omit({ replayed: true })
  .extend({
    [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: z.string().regex(/^[a-f0-9]{64}$/),
    sandboxAllocation: sandboxAllocationSchema.optional(),
    initialMessageId: MessageIdSchema.optional(),
  })
  .strict();

const ingestResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      clone: z
        .object({
          sessionId: kiloSessionIdSchema,
          copiedItemCount: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z.object({ status: z.literal('in_progress') }).strict(),
  z.object({ status: z.literal('rejected'), code: z.string().min(1) }).strict(),
]);

const registrationResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }).strip(),
  z.object({ success: z.literal(false), error: z.string().optional() }).strip(),
]);

type WorktreeInput = z.infer<typeof CreateWorktreeChatInput>;
type HostedWorkspaceSessionInput = z.infer<typeof CreateHostedWorkspaceSessionInput>;
type WorktreeResult = z.infer<typeof CreateWorktreeChatOutput>;
type HostedWorkspaceSessionResult = z.infer<typeof CreateHostedWorkspaceSessionOutput>;
type OwnershipRow = z.infer<typeof ownershipRowSchema>;
type OperationProgress = z.infer<typeof operationProgressSchema>;
type WorktreeSource = {
  ownership: OwnershipRow;
  metadata: SessionMetadata;
  workspace: NonNullable<SessionMetadata['workspace']> & {
    sandboxId: NonNullable<NonNullable<SessionMetadata['workspace']>['sandboxId']>;
    sandboxProvider: NonNullable<NonNullable<SessionMetadata['workspace']>['sandboxProvider']>;
  };
  repository: NonNullable<SessionMetadata['repository']>;
  worktreeId: CloudAgentWorktreeId;
};

type SiblingAgentSelection = {
  mode: string;
  model: string;
  variant?: string;
};

type SiblingCreateOptions = {
  fingerprint: string;
  requestedKiloSessionId: string | undefined;
  /** Session-scoped agent selection persisted on the new root's metadata. */
  agent?: SiblingAgentSelection;
  /** Idempotent initial-turn delivery for a sibling that starts with a prompt. */
  initialTurn?: {
    messageId: string;
    /** Client-supplied id; only this value pins the immutable intent. */
    requestedMessageId?: string;
    deliver: (progress: OperationProgress, rowId: string) => Promise<void>;
  };
};

const WORKTREE_CREATE_LEDGER_LEASE_SECONDS = 120;

function sourceRejected(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'worktree_source_not_eligible' });
}

function operationConflict(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
}

function creationInProgress(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: 'creation_in_progress' });
}

function creationFailed(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'worktree_chat_creation_failed' });
}

async function findOwnershipRow(
  db: WorkerDb,
  userId: string,
  kiloSessionId: string,
  cloudAgentSessionId: string
): Promise<OwnershipRow | null> {
  const [row] = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      userId: cli_sessions_v2.kilo_user_id,
      organizationId: cli_sessions_v2.organization_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      createdOnPlatform: cli_sessions_v2.created_on_platform,
      parentSessionId: cli_sessions_v2.parent_session_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
      gitUrl: cli_sessions_v2.git_url,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.session_id, kiloSessionId),
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);

  if (!row) return null;
  const parsed = ownershipRowSchema.safeParse(row);
  if (!parsed.success) throw sourceRejected();
  return parsed.data;
}

function canonicalRepositoryUrl(repository: WorktreeSource['repository']): string {
  return normalizeGitUrl(
    repository.type === 'github' ? `https://github.com/${repository.repo}` : repository.url
  );
}

/** Origins whose hosted roots may act as a workspace source for a sibling. */
const HOSTED_WORKSPACE_SOURCE_ORIGINS = new Set(['cloud-agent-web', 'agent-manager']);

type SourceRequirements = {
  organizationId: string | undefined;
  /** Old sibling API only: the source must be its own workspace scope root. */
  requireSourceScopeId?: string;
  allowedOrigins: ReadonlySet<string>;
};

async function loadSourceMetadata(
  ctx: TRPCContext,
  ownership: OwnershipRow,
  worktreeId: CloudAgentWorktreeId,
  requirements: SourceRequirements
): Promise<WorktreeSource | null> {
  const rawMetadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, ownership.cloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  const parsedMetadata = CurrentSessionMetadataSchema.safeParse(rawMetadata);
  if (!parsedMetadata.success) return null;

  const metadata = parsedMetadata.data;
  const workspace = metadata.workspace;
  const repository = metadata.repository;
  if (
    !workspace ||
    !repository ||
    !workspace.sandboxId ||
    !workspace.sandboxProvider ||
    !metadata.agent?.mode ||
    !metadata.agent.model ||
    metadata.identity.userId !== ctx.userId ||
    metadata.identity.orgId !== requirements.organizationId ||
    metadata.identity.sessionId !== ownership.cloudAgentSessionId ||
    metadata.auth.kiloSessionId !== ownership.kiloSessionId ||
    metadata.identity.createdOnPlatform !== ownership.createdOnPlatform ||
    !requirements.allowedOrigins.has(ownership.createdOnPlatform) ||
    (requirements.requireSourceScopeId !== undefined &&
      ownership.cloudAgentSessionScopeId !== requirements.requireSourceScopeId) ||
    metadata.identity.botId !== undefined ||
    metadata.devcontainer !== undefined ||
    workspace.devcontainerRequested === true ||
    workspace.worktreeId !== worktreeId ||
    workspace.workspacePath !==
      getWorktreeWorkspacePath(requirements.organizationId, ctx.userId, worktreeId) ||
    (ownership.gitUrl !== null &&
      normalizeGitUrl(ownership.gitUrl) !== canonicalRepositoryUrl(repository))
  ) {
    return null;
  }

  const binding = getSandboxProviderBinding(metadata);
  if (binding.kind === 'vercel' && binding.source.kind === 'platform') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: VERCEL_BYOC_REQUIRED_MESSAGE });
  }

  return {
    ownership,
    metadata,
    workspace: {
      ...workspace,
      sandboxId: workspace.sandboxId,
      sandboxProvider: workspace.sandboxProvider,
    },
    repository,
    worktreeId,
  };
}

async function loadWorktreeSource(
  db: WorkerDb,
  ctx: TRPCContext,
  input: WorktreeInput
): Promise<WorktreeSource> {
  if (ctx.botId !== undefined) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  if (input.kilocodeOrganizationId) {
    await assertOrganizationMembership(db, ctx.userId, input.kilocodeOrganizationId);
  }

  const ownership = await findOwnershipRow(
    db,
    ctx.userId,
    input.sourceKiloSessionId,
    input.sourceCloudAgentSessionId
  );
  if (!ownership || ownership.organizationId !== (input.kilocodeOrganizationId ?? null)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  const worktreeId = ownership.worktreeId;
  if (
    !worktreeId ||
    ownership.parentSessionId !== null ||
    ownership.cloudAgentSessionScopeId !== input.sourceCloudAgentSessionId
  ) {
    throw sourceRejected();
  }

  const source = await loadSourceMetadata(ctx, ownership, worktreeId, {
    organizationId: input.kilocodeOrganizationId,
    requireSourceScopeId: input.sourceCloudAgentSessionId,
    allowedOrigins: new Set(['cloud-agent-web']),
  });
  if (!source) throw sourceRejected();
  return source;
}

function workspaceUnavailable(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: WORKSPACE_UNAVAILABLE });
}

function workspaceDeleting(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: WORKSPACE_DELETING });
}

function workspaceIdentityConflict(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: WORKSPACE_IDENTITY_CONFLICT });
}

/**
 * Load a usable hosted source for `workspaceId` without a caller-supplied
 * source session. The immutable workspace identity (repository, ref, profile,
 * organization, placement) is derived from the workspace's roots; the caller
 * cannot override any of it.
 */
async function loadWorkspaceSource(
  db: WorkerDb,
  ctx: TRPCContext,
  workspaceId: CloudAgentWorktreeId,
  organizationId: string | undefined
): Promise<WorktreeSource> {
  if (ctx.botId !== undefined || ctx.cloudAgentAuthority !== undefined) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }
  if (organizationId) {
    await assertOrganizationMembership(db, ctx.userId, organizationId);
  }

  const [workspace] = await db
    .select({
      organizationId: cloud_agent_worktrees.organization_id,
      deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
    })
    .from(cloud_agent_worktrees)
    .where(
      and(
        eq(cloud_agent_worktrees.worktree_id, workspaceId),
        eq(cloud_agent_worktrees.kilo_user_id, ctx.userId)
      )
    )
    .limit(1);
  if (!workspace) throw workspaceUnavailable();
  if (workspace.deletionStartedAt !== null) throw workspaceDeleting();

  const roots = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      userId: cli_sessions_v2.kilo_user_id,
      organizationId: cli_sessions_v2.organization_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      createdOnPlatform: cli_sessions_v2.created_on_platform,
      parentSessionId: cli_sessions_v2.parent_session_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
      gitUrl: cli_sessions_v2.git_url,
      gitBranch: cli_sessions_v2.git_branch,
      profileId: cli_sessions_v2.profile_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, ctx.userId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, workspaceId),
        isNull(cli_sessions_v2.parent_session_id)
      )
    )
    .orderBy(asc(cli_sessions_v2.created_at), asc(cli_sessions_v2.session_id));
  if (roots.length === 0) throw workspaceUnavailable();

  const workspaceOrganizationId = roots[0]?.organizationId ?? null;
  if (
    workspaceOrganizationId !== (organizationId ?? null) ||
    roots.some(root => root.organizationId !== workspaceOrganizationId)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }
  if (workspace.organizationId !== workspaceOrganizationId) {
    throw workspaceIdentityConflict();
  }

  let source: WorktreeSource | undefined;
  for (const root of roots) {
    const parsed = ownershipRowSchema.safeParse(root);
    if (!parsed.success || parsed.data.parentSessionId !== null) continue;
    const candidate = await loadSourceMetadata(ctx, parsed.data, workspaceId, {
      organizationId,
      allowedOrigins: HOSTED_WORKSPACE_SOURCE_ORIGINS,
    });
    if (candidate) {
      source = candidate;
      break;
    }
  }
  if (!source) throw workspaceUnavailable();

  const canonicalUrl = canonicalRepositoryUrl(source.repository);
  const canonicalProfileId = roots.find(root => root.profileId !== null)?.profileId ?? null;
  const canonicalRootBranch = roots.find(root => root.gitBranch !== null)?.gitBranch ?? null;
  for (const root of roots) {
    if (root.gitUrl !== null && normalizeGitUrl(root.gitUrl) !== canonicalUrl) {
      throw workspaceIdentityConflict();
    }
    if (
      canonicalRootBranch !== null &&
      root.gitBranch !== null &&
      root.gitBranch !== canonicalRootBranch
    ) {
      throw workspaceIdentityConflict();
    }
    if (root.profileId !== null && root.profileId !== canonicalProfileId) {
      throw workspaceIdentityConflict();
    }
  }

  return source;
}

async function worktreeIntentFingerprint(
  input: WorktreeInput,
  source: WorktreeSource
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      sourceKiloSessionId: input.sourceKiloSessionId,
      sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
      organizationId: input.kilocodeOrganizationId ?? null,
      worktreeId: source.worktreeId,
      clientProvenance: input.clientProvenance,
      // Only when proposed, so operations created before this field keep their fingerprint.
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
      ...(source.workspace.sandboxAllocation
        ? { sandboxAllocation: source.workspace.sandboxAllocation }
        : {}),
      ...(source.workspace.egressMode === 'allowlist'
        ? {
            egressMode: source.workspace.egressMode,
            egressAllowlist: source.workspace.egressAllowlist ?? [],
          }
        : {}),
    })
  );
}

async function workspaceSessionIntentFingerprint(
  input: HostedWorkspaceSessionInput,
  source: WorktreeSource
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      workspaceId: source.worktreeId,
      organizationId: input.kilocodeOrganizationId ?? null,
      clientProvenance: input.clientProvenance,
      agent: input.agent,
      message: {
        id: input.message.id ?? null,
        prompt: input.message.prompt,
        attachments: input.message.attachments ?? null,
      },
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
      ...(source.workspace.sandboxAllocation
        ? { sandboxAllocation: source.workspace.sandboxAllocation }
        : {}),
      ...(source.workspace.egressMode === 'allowlist'
        ? {
            egressMode: source.workspace.egressMode,
            egressAllowlist: source.workspace.egressAllowlist ?? [],
          }
        : {}),
    })
  );
}

function readOperationProgress(
  row: OperationLedgerRow,
  source: WorktreeSource,
  fingerprint: string,
  initialMessageId?: string
): OperationProgress | undefined {
  if (row.canonical_result === null) return undefined;
  const progress = operationProgressSchema.safeParse(row.canonical_result);
  if (
    !progress.success ||
    progress.data.worktreeId !== source.worktreeId ||
    progress.data.sandboxAllocation !== source.workspace.sandboxAllocation ||
    progress.data[SESSION_CREATE_INTENT_FINGERPRINT_KEY] !== fingerprint ||
    (initialMessageId !== undefined && progress.data.initialMessageId !== initialMessageId)
  ) {
    throw operationConflict();
  }
  return progress.data;
}

function resultFromProgress(progress: OperationProgress, replayed = false): WorktreeResult {
  const result = {
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
    worktreeId: progress.worktreeId,
  };
  return replayed ? { ...result, replayed: true } : result;
}

type WorktreeRuntimeAuthorization = { token: string; seal: string } | undefined;

/**
 * Establish whether the current caller presented modern control authority.
 * This deliberately verifies the token instead of inferring its type from an
 * untrusted decoded JWT payload.  The actual authorization is re-created for
 * each registration RPC below, which also re-checks principal and membership
 * bindings.
 */
async function requiresRuntimeAuthorization(ctx: TRPCContext): Promise<boolean> {
  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication unavailable' });
  }
  try {
    const verified = await verifyKiloTokenForPolicy(ctx.authToken, secret, {
      audience: 'cloud-agent-next',
      mode: 'allow-legacy',
    });
    const modern =
      verified.claims.tokenPurpose !== undefined ||
      verified.claims.credentialExchange !== undefined ||
      verified.claims.runtimeAdmission !== undefined;
    if (modern && verified.claims.runtimeAdmission === undefined) {
      throw new Error('Missing runtime admission');
    }
    return modern;
  } catch {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

async function createDestinationRuntimeAuthorization(
  ctx: TRPCContext,
  progress: OperationProgress,
  organizationId: string | undefined
): Promise<WorktreeRuntimeAuthorization> {
  if (!(await requiresRuntimeAuthorization(ctx))) return undefined;

  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication unavailable' });
  }
  try {
    const created = await createRuntimeAuthorization({
      token: ctx.authToken,
      secret,
      connectionString: ctx.env.HYPERDRIVE.connectionString,
      resourceKind: 'cloud-agent-next',
      resourceId: progress.cloudAgentSessionId,
      ...(organizationId ? { organizationId } : {}),
    });
    return {
      token: created.token,
      seal: await sealRuntimeAuthorization(created.authorization, secret),
    };
  } catch {
    // Membership, principal, and token admission can all change between a
    // lost response and a replay. Never revive a destination on stale control
    // authority.
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

async function assertNewDestinationRuntimeIsolation(ctx: TRPCContext): Promise<void> {
  if (await requiresRuntimeAuthorization(ctx)) assertRuntimeIsolationAdmission(ctx.env);
}

function allowsSubagentSessionsForWorktree(source: WorktreeSource): boolean {
  return (
    isInteractiveSessionOrigin(source.metadata.identity.createdOnPlatform) &&
    source.workspace.sandboxAllocation !== 'cloudflare-shared' &&
    source.workspace.sandboxKind !== 'shared' &&
    source.workspace.sandboxRoute?.kind !== 'shared'
  );
}

function sourceWorktreeBranchName(source: WorktreeSource): string {
  return (
    source.workspace.branchName ??
    source.repository.upstreamBranch ??
    `session/${source.worktreeId}`
  );
}

function buildRegistrationInput(
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress,
  runtimeAuthorization: WorktreeRuntimeAuthorization,
  agentOverride?: SiblingAgentSelection
): Parameters<ReturnType<typeof getSandboxSessionStub>['registerSessionFromMetadata']>[0] {
  const repository = { ...source.repository };
  if ('token' in repository) delete repository.token;

  const workspace = { ...source.workspace };
  delete workspace.providerRuntime;
  workspace.branchName = sourceWorktreeBranchName(source);

  const baseAgent = source.metadata.agent;
  if (!baseAgent) throw operationConflict();
  const agent: typeof baseAgent = agentOverride
    ? {
        mode: agentOverride.mode,
        model: agentOverride.model,
        ...(agentOverride.variant !== undefined ? { variant: agentOverride.variant } : {}),
        ...(baseAgent.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: baseAgent.appendSystemPrompt }
          : {}),
      }
    : baseAgent;

  const now = Date.now();
  // Explicit field list: a sibling session inherits route/agent/profile but not
  // the parent's callback, clone source, devcontainer runtime or initial
  // message. `workspace` is the resolved worktree placement.
  const metadata: SessionMetadata = {
    metadataSchemaVersion: 2,
    allowSubagentSessions:
      allowsSubagentSessionsForWorktree(source) && runtimeAuthorization !== undefined,
    identity: { ...source.metadata.identity, sessionId: progress.cloudAgentSessionId },
    auth: {
      ...source.metadata.auth,
      kiloSessionId: progress.kiloSessionId,
      kilocodeToken: runtimeAuthorization?.token ?? ctx.authToken,
    },
    agent,
    repository,
    ...(source.metadata.profile ? { profile: source.metadata.profile } : {}),
    ...(source.metadata.environment ? { environment: source.metadata.environment } : {}),
    ...(source.metadata.finalization ? { finalization: source.metadata.finalization } : {}),
    workspace,
    lifecycle: { version: now, timestamp: now },
  };

  return {
    metadata,
    sandboxSelection: buildControlPlaneSandboxSelection(metadata, ctx.env, workspace.sandboxId),
    ...(runtimeAuthorization ? { runtimeAuthorizationSeal: runtimeAuthorization.seal } : {}),
  };
}

async function assertDestinationRuntimeAuthorizationActive(
  ctx: TRPCContext,
  sessionId: string
): Promise<void> {
  if (!(await requiresRuntimeAuthorization(ctx))) return;
  const status = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.getRuntimeAuthorizationStatus(),
    'getRuntimeAuthorizationStatus'
  );
  if (status.state !== 'active') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

function assertRegisteredMetadata(
  rawMetadata: unknown,
  source: WorktreeSource,
  progress: OperationProgress
): void {
  const parsed = CurrentSessionMetadataSchema.safeParse(rawMetadata);
  if (!parsed.success) throw operationConflict();

  const metadata = parsed.data;
  const workspace = metadata.workspace;
  if (
    metadata.identity.sessionId !== progress.cloudAgentSessionId ||
    metadata.identity.userId !== source.metadata.identity.userId ||
    metadata.identity.orgId !== source.metadata.identity.orgId ||
    metadata.identity.createdOnPlatform !== source.metadata.identity.createdOnPlatform ||
    metadata.auth.kiloSessionId !== progress.kiloSessionId ||
    !workspace ||
    workspace.worktreeId !== source.worktreeId ||
    workspace.workspacePath !== source.workspace.workspacePath ||
    workspace.sandboxId !== source.workspace.sandboxId ||
    workspace.sandboxProvider !== source.workspace.sandboxProvider ||
    workspace.sandboxAllocation !== source.workspace.sandboxAllocation ||
    (workspace.egressMode ?? 'unrestricted') !== (source.workspace.egressMode ?? 'unrestricted') ||
    JSON.stringify(workspace.egressAllowlist ?? []) !==
      JSON.stringify(source.workspace.egressAllowlist ?? []) ||
    !sameSandboxProviderBinding(
      getSandboxProviderBinding(metadata),
      getSandboxProviderBinding(source.metadata)
    ) ||
    workspace.branchName !== sourceWorktreeBranchName(source) ||
    JSON.stringify(workspace.sandboxRoute) !== JSON.stringify(source.workspace.sandboxRoute) ||
    workspace.sandboxKind !== source.workspace.sandboxKind ||
    !metadata.repository ||
    canonicalRepositoryUrl(metadata.repository) !== canonicalRepositoryUrl(source.repository) ||
    (source.repository.type === 'github' &&
      (metadata.repository.type !== 'github' ||
        metadata.repository.githubIntegrationId !== source.repository.githubIntegrationId ||
        metadata.repository.allowUserAuthorization !== source.repository.allowUserAuthorization ||
        (metadata.repository.githubAccessPurpose ?? 'workflow') !==
          (source.repository.githubAccessPurpose ?? 'workflow'))) ||
    metadata.repository.upstreamBranch !== source.repository.upstreamBranch
  ) {
    throw operationConflict();
  }
}

async function markPending(db: WorkerDb, rowId: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const row = await markReconcilePending(db, { rowId });
    logControlDiagnostic('worktree_chat_reconciliation', {
      operationRowId: rowId,
      result: row?.status === 'reconcile_pending' ? 'pending' : 'not_pending',
      durationMs: Date.now() - startedAt,
    });
  } catch {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        operationRowId: rowId,
        result: 'mark_failed',
        stage: 'reconciliation_mark',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    return;
  }
}

async function createOwnershipRow(
  db: WorkerDb,
  rowId: string,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  let response: unknown;
  try {
    response = await ctx.env.SESSION_INGEST.createSessionForCloudAgent({
      sessionId: progress.kiloSessionId,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: progress.cloudAgentSessionId,
      cloudAgentWorktreeId: source.worktreeId,
      cloudAgentWorktreeLocation: {
        sandboxId: source.workspace.sandboxId,
        provider: source.workspace.sandboxProvider,
      },
      organizationId: source.ownership.organizationId ?? undefined,
      createdOnPlatform: source.ownership.createdOnPlatform,
      profileId: source.ownership.profileId ?? undefined,
      title: `New session - ${new Date().toISOString()}`,
      gitUrl: source.ownership.gitUrl ?? canonicalRepositoryUrl(source.repository),
    });
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: 'ownership_outcome_unknown',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }

  const parsed = ingestResultSchema.safeParse(response);
  if (!parsed.success || parsed.data.status === 'in_progress') {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: parsed.success ? 'ownership_in_progress' : 'ownership_response_invalid',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
  if (parsed.data.status === 'rejected') {
    try {
      const settlement = await settleOperation(db, {
        rowId,
        status: 'failed',
        outcomeCode: 'ownership_row_rejected',
      });
      logControlDiagnostic('worktree_chat_settlement', {
        ...diagnostic,
        requestedStatus: 'failed',
        outcomeCode: 'ownership_row_rejected',
        settled: settlement.settled,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_settlement',
        {
          ...diagnostic,
          result: 'failed',
          stage: 'ownership_settlement',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'rejected',
        stage: 'ownership',
        reason: 'ownership_row_rejected',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw creationFailed();
  }
  if (
    parsed.data.clone.sessionId !== progress.kiloSessionId ||
    parsed.data.clone.copiedItemCount !== 0
  ) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: 'ownership_result_mismatch',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
}

async function completeOperation(
  db: WorkerDb,
  rowId: string,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: progress.worktreeId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  logControlDiagnostic('worktree_chat_settlement', {
    ...diagnostic,
    requestedStatus: 'completed',
    result: 'started',
  });
  try {
    const settlement = await settleOperation(db, {
      rowId,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: resultFromProgress(progress),
    });
    logControlDiagnostic('worktree_chat_settlement', {
      ...diagnostic,
      requestedStatus: 'completed',
      outcomeCode: 'ok',
      settled: settlement.settled,
      durationMs: Date.now() - startedAt,
    });
    if (!settlement.settled) throw creationInProgress();
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'completion_settlement',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }
}

async function registerWorktreeSession(
  db: WorkerDb,
  rowId: string,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress,
  options?: Pick<SiblingCreateOptions, 'agent' | 'initialTurn'>
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  let registrationAttempted = false;
  let response: unknown;

  try {
    response = await withDORetry(
      () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
      async stub => {
        if (registrationAttempted) {
          const existing = await stub.getMetadata();
          if (existing) {
            assertRegisteredMetadata(existing, source, progress);
            await assertDestinationRuntimeAuthorizationActive(ctx, progress.cloudAgentSessionId);
            logControlDiagnostic('worktree_chat_reconciliation', {
              ...diagnostic,
              result: 'registration_recovered',
              durationMs: Date.now() - startedAt,
            });
            return { success: true };
          }
        }
        registrationAttempted = true;
        await assertNewDestinationRuntimeIsolation(ctx);
        const runtimeAuthorization = await createDestinationRuntimeAuthorization(
          ctx,
          progress,
          source.ownership.organizationId ?? undefined
        );
        return stub.registerSessionFromMetadata(
          buildRegistrationInput(source, ctx, progress, runtimeAuthorization, options?.agent)
        );
      },
      'registerSession'
    );
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'registration',
        reason: 'registration_outcome_unknown',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }

  const result = registrationResultSchema.safeParse(response);
  if (!result.success) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'registration',
        reason: 'registration_response_invalid',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
  if (!result.data.success) {
    try {
      await ctx.env.SESSION_INGEST.deleteSessionForCloudAgent({
        sessionId: progress.kiloSessionId,
        kiloUserId: ctx.userId,
        onlyIfEmpty: true,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'reconciliation_pending',
          stage: 'registration_cleanup',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      await markPending(db, rowId);
      throw error;
    }
    try {
      const settlement = await settleOperation(db, {
        rowId,
        status: 'failed',
        outcomeCode: 'registration_rejected',
      });
      logControlDiagnostic('worktree_chat_settlement', {
        ...diagnostic,
        requestedStatus: 'failed',
        outcomeCode: 'registration_rejected',
        settled: settlement.settled,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_settlement',
        {
          ...diagnostic,
          result: 'failed',
          stage: 'registration_settlement',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'rejected',
        stage: 'registration',
        reason: 'registration_rejected',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'worktree_chat_registration_failed',
    });
  }

  if (options?.initialTurn) {
    try {
      await options.initialTurn.deliver(progress, rowId);
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'reconciliation_pending',
          stage: 'initial_turn',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      await markPending(db, rowId);
      throw error;
    }
  }

  await completeOperation(db, rowId, progress);
}

async function executeWorktreeCreate(
  db: WorkerDb,
  row: OperationLedgerRow,
  source: WorktreeSource,
  ctx: TRPCContext,
  options: SiblingCreateOptions
): Promise<OperationProgress> {
  const startedAt = Date.now();
  await assertNewDestinationRuntimeIsolation(ctx);
  const progress = operationProgressSchema.parse({
    cloudAgentSessionId: generateSessionId(),
    kiloSessionId: options.requestedKiloSessionId ?? generateKiloSessionId(),
    worktreeId: source.worktreeId,
    [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: options.fingerprint,
    ...(options.initialTurn ? { initialMessageId: options.initialTurn.messageId } : {}),
    ...(source.workspace.sandboxAllocation
      ? { sandboxAllocation: source.workspace.sandboxAllocation }
      : {}),
  });
  const diagnostic = {
    operationRowId: row.id,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  try {
    const recorded = await recordOperationProgress(db, row.id, progress);
    if (!recorded) throw creationInProgress();
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'progress_recording',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  }
  logControlDiagnostic('worktree_chat_progress', {
    ...diagnostic,
    result: 'recorded',
    durationMs: Date.now() - startedAt,
  });
  await createOwnershipRow(db, row.id, source, ctx, progress);
  await registerWorktreeSession(db, row.id, source, ctx, progress, options);
  logControlDiagnostic('worktree_chat_result', {
    ...diagnostic,
    result: 'new',
    durationMs: Date.now() - startedAt,
  });
  return progress;
}

async function reconcileWorktreeCreate(
  db: WorkerDb,
  row: OperationLedgerRow,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress | undefined,
  options: SiblingCreateOptions
): Promise<OperationProgress> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: row.id,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress?.cloudAgentSessionId,
    kiloSessionId: progress?.kiloSessionId,
  };
  logControlDiagnostic('worktree_chat_reconciliation', {
    ...diagnostic,
    result: progress ? 'started' : 'no_progress',
  });
  if (!progress) {
    return executeWorktreeCreate(db, row, source, ctx, options);
  }

  const existingMetadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  ).catch(error => {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        ...diagnostic,
        result: 'failed',
        stage: 'reconciliation_metadata_read',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  });
  if (existingMetadata) {
    try {
      assertRegisteredMetadata(existingMetadata, source, progress);
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'rejected',
          stage: 'reconciliation_metadata',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    await assertDestinationRuntimeAuthorizationActive(ctx, progress.cloudAgentSessionId);
  } else {
    await assertNewDestinationRuntimeIsolation(ctx);
  }

  const ownership = await findOwnershipRow(
    db,
    ctx.userId,
    progress.kiloSessionId,
    progress.cloudAgentSessionId
  ).catch(error => {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        ...diagnostic,
        result: 'failed',
        stage: 'reconciliation_ownership_read',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  });
  logControlDiagnostic('worktree_chat_reconciliation', {
    ...diagnostic,
    result: 'observed',
    hasRegisteredMetadata: Boolean(existingMetadata),
    hasOwnership: Boolean(ownership),
    durationMs: Date.now() - startedAt,
  });
  if (ownership) {
    if (
      ownership.organizationId !== source.ownership.organizationId ||
      ownership.worktreeId !== source.worktreeId ||
      ownership.parentSessionId !== null ||
      ownership.cloudAgentSessionScopeId !== progress.cloudAgentSessionId
    ) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'rejected',
          stage: 'reconciliation_ownership',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw operationConflict();
    }
  } else {
    await createOwnershipRow(db, row.id, source, ctx, progress);
  }

  if (existingMetadata) {
    if (options.initialTurn) {
      try {
        await options.initialTurn.deliver(progress, row.id);
      } catch (error) {
        logControlDiagnostic(
          'worktree_chat_result',
          {
            ...diagnostic,
            result: 'reconciliation_pending',
            stage: 'initial_turn',
            durationMs: Date.now() - startedAt,
          },
          'warn'
        );
        await markPending(db, row.id);
        throw error;
      }
    }
    await completeOperation(db, row.id, progress);
  } else {
    await registerWorktreeSession(db, row.id, source, ctx, progress, options);
  }

  logControlDiagnostic('worktree_chat_result', {
    ...diagnostic,
    result: 'replayed',
    durationMs: Date.now() - startedAt,
  });
  return progress;
}

type SiblingCreateRun = {
  db: WorkerDb;
  ctx: TRPCContext;
  source: WorktreeSource;
  intent: 'create_worktree_chat' | 'create_workspace_session';
  operationKey: string;
  organizationId: string | undefined;
  options: SiblingCreateOptions;
  sourceSession?: { kiloSessionId: string; cloudAgentSessionId: string };
  mapProgress: (
    progress: OperationProgress,
    replayed: boolean
  ) => WorktreeResult | HostedWorkspaceSessionResult;
};

async function runSiblingCreate(
  run: SiblingCreateRun
): Promise<WorktreeResult | HostedWorkspaceSessionResult> {
  const { db, ctx, source, intent, operationKey, organizationId, options } = run;
  const startedAt = Date.now();
  const admission = await admitOperation(db, {
    userId: ctx.userId,
    orgId: organizationId,
    domain: 'session',
    intent,
    operationKey,
    resourceKey: source.worktreeId,
    taxonomy: 'safe-retry',
    leaseSeconds: WORKTREE_CREATE_LEDGER_LEASE_SECONDS,
  }).catch(error => {
    logControlDiagnostic(
      'worktree_chat_admission',
      {
        operationKey,
        intent,
        worktreeId: source.worktreeId,
        sourceCloudAgentSessionId: run.sourceSession?.cloudAgentSessionId,
        sourceKiloSessionId: run.sourceSession?.kiloSessionId,
        result: 'failed',
        stage: 'admission',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  });
  const diagnostic = {
    operationKey,
    operationRowId: admission.row.id,
    intent,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: run.sourceSession?.cloudAgentSessionId,
    sourceKiloSessionId: run.sourceSession?.kiloSessionId,
    admission: admission.admission,
  };
  logControlDiagnostic('worktree_chat_admission', {
    ...diagnostic,
    durationMs: Date.now() - startedAt,
  });

  let progress: OperationProgress | undefined;
  try {
    assertSessionOperationIdentity(admission.row, {
      userId: ctx.userId,
      intent,
      organizationId,
      resourceKey: source.worktreeId,
    });
    progress = readOperationProgress(
      admission.row,
      source,
      options.fingerprint,
      options.initialTurn?.requestedMessageId
    );
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'rejected',
        stage: 'operation_identity',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  }
  const resultDiagnostic = {
    ...diagnostic,
    cloudAgentSessionId: progress?.cloudAgentSessionId,
    kiloSessionId: progress?.kiloSessionId,
  };

  switch (admission.admission) {
    case 'admitted':
      if (progress) {
        logControlDiagnostic(
          'worktree_chat_result',
          {
            ...resultDiagnostic,
            result: 'rejected',
            stage: 'admission',
            reason: 'unexpected_progress',
            durationMs: Date.now() - startedAt,
          },
          'warn'
        );
        throw operationConflict();
      }
      return run.mapProgress(
        await executeWorktreeCreate(db, admission.row, source, ctx, options),
        false
      );
    case 'duplicate_settled':
      if (admission.row.status !== 'completed' || !progress) {
        logControlDiagnostic(
          'worktree_chat_result',
          {
            ...resultDiagnostic,
            result: 'rejected',
            stage: 'replay',
            reason: 'settled_result_unavailable',
            durationMs: Date.now() - startedAt,
          },
          'warn'
        );
        throw creationFailed();
      }
      logControlDiagnostic('worktree_chat_result', {
        ...resultDiagnostic,
        result: 'replayed',
        durationMs: Date.now() - startedAt,
      });
      return run.mapProgress(progress, true);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      logControlDiagnostic('worktree_chat_result', {
        ...resultDiagnostic,
        result: 'reconciliation_pending',
        stage: 'admission',
        durationMs: Date.now() - startedAt,
      });
      throw creationInProgress();
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return run.mapProgress(
        await reconcileWorktreeCreate(db, admission.row, source, ctx, progress, options),
        true
      );
  }
}

function hostedResultFromProgress(
  progress: OperationProgress,
  replayed: boolean
): HostedWorkspaceSessionResult {
  if (!progress.initialMessageId) throw creationInProgress();
  return {
    workspaceId: progress.worktreeId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
    messageId: progress.initialMessageId,
    ...(replayed ? { replayed: true } : {}),
  };
}

async function initialTurnState(
  ctx: TRPCContext,
  progress: OperationProgress,
  messageId: string
): Promise<'admitted' | 'missing' | 'failed'> {
  const result: MessageResultRPCResponse = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
    (stub): Promise<MessageResultRPCResponse> => stub.getMessageResult(messageId),
    'getMessageResult'
  );
  if (result.type === 'state-invalid') throw creationInProgress();
  if (result.type !== 'found') return 'missing';
  if (result.result.status === 'failed' || result.result.status === 'interrupted') return 'failed';
  return 'admitted';
}

function rpcErrorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonRetryableInitialTurnFailure(error: unknown): boolean {
  if (!(error instanceof TRPCError)) return false;
  const code = String(error.code);
  return (
    code === 'BAD_REQUEST' ||
    code === 'FORBIDDEN' ||
    code === 'UNAUTHORIZED' ||
    code === 'NOT_FOUND' ||
    code === 'PAYMENT_REQUIRED' ||
    code === 'TOO_MANY_REQUESTS'
  );
}

async function discardUnadmittedSibling(
  ctx: TRPCContext,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  try {
    await ctx.env.SESSION_INGEST.deleteHostedWorkspaceSession({
      kiloUserId: ctx.userId,
      workspaceId: progress.worktreeId,
      sessionId: progress.kiloSessionId,
      cloudAgentSessionId: progress.cloudAgentSessionId,
    });
  } catch (error) {
    // Keep the only remaining root instead of leaving the workspace rootless.
    if (rpcErrorCode(error).includes(WORKSPACE_REQUIRES_ROOT_SESSION)) return;
    throw error;
  }
  try {
    await withDORetry(
      () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
      stub => stub.deleteSession(),
      'deleteSession'
    );
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        worktreeId: progress.worktreeId,
        cloudAgentSessionId: progress.cloudAgentSessionId,
        kiloSessionId: progress.kiloSessionId,
        result: 'reconciliation_pending',
        stage: 'initial_turn_cleanup',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  }
}

const createWorktreeChatHandler = protectedProcedure
  .input(CreateWorktreeChatInput)
  .output(CreateWorktreeChatOutput)
  .mutation(async ({ input, ctx }) => {
    const db = getPgDb(ctx.env);
    const source = await loadWorktreeSource(db, ctx, input);
    const fingerprint = await worktreeIntentFingerprint(input, source);
    return CreateWorktreeChatOutput.parse(
      await runSiblingCreate({
        db,
        ctx,
        source,
        intent: 'create_worktree_chat',
        operationKey: input.operationKey,
        organizationId: input.kilocodeOrganizationId,
        options: { fingerprint, requestedKiloSessionId: input.kiloSessionId },
        sourceSession: {
          kiloSessionId: input.sourceKiloSessionId,
          cloudAgentSessionId: input.sourceCloudAgentSessionId,
        },
        mapProgress: (progress, replayed) => resultFromProgress(progress, replayed),
      })
    );
  });

const createHostedWorkspaceSessionHandler = protectedProcedure
  .input(CreateHostedWorkspaceSessionInput)
  .output(CreateHostedWorkspaceSessionOutput)
  .mutation(async ({ input, ctx }) => {
    const db = getPgDb(ctx.env);
    const source = await loadWorkspaceSource(
      db,
      ctx,
      input.workspaceId,
      input.kilocodeOrganizationId
    );
    assertModeAvailableForProfile(input.agent.mode, source.metadata.profile ?? {});
    const requestedMessageId = input.message.id;
    const initialMessageId = requestedMessageId ?? createMessageId();
    const fingerprint = await workspaceSessionIntentFingerprint(input, source);

    const deliver = async (progress: OperationProgress, rowId: string): Promise<void> => {
      const messageId = progress.initialMessageId;
      if (!messageId) throw creationInProgress();
      const state = await initialTurnState(ctx, progress, messageId);
      if (state === 'admitted') return;
      if (state === 'failed') {
        await settleOperation(db, {
          rowId,
          status: 'failed',
          outcomeCode: 'initial_turn_failed',
        }).catch(() => undefined);
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' });
      }
      try {
        await preflightAndQueuePromptMessage(
          {
            cloudAgentSessionId: progress.cloudAgentSessionId,
            turn: {
              type: 'prompt',
              id: messageId,
              prompt: input.message.prompt,
              ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
            },
            agent: input.agent,
          },
          { env: ctx.env, userId: ctx.userId, botId: ctx.botId, authToken: ctx.authToken },
          'createHostedWorkspaceSession'
        );
      } catch (error) {
        if (isNonRetryableInitialTurnFailure(error)) {
          await discardUnadmittedSibling(ctx, progress).catch(() => undefined);
          await settleOperation(db, {
            rowId,
            status: 'failed',
            outcomeCode: 'initial_turn_rejected',
          }).catch(() => undefined);
        }
        throw error;
      }
    };

    return CreateHostedWorkspaceSessionOutput.parse(
      await runSiblingCreate({
        db,
        ctx,
        source,
        intent: 'create_workspace_session',
        operationKey: input.operationKey,
        organizationId: input.kilocodeOrganizationId,
        options: {
          fingerprint,
          requestedKiloSessionId: input.kiloSessionId,
          agent: input.agent,
          initialTurn: {
            messageId: initialMessageId,
            ...(requestedMessageId ? { requestedMessageId } : {}),
            deliver,
          },
        },
        mapProgress: (progress, replayed) => hostedResultFromProgress(progress, replayed),
      })
    );
  });

export function createSessionWorktreeHandlers(): {
  createWorktreeChat: typeof createWorktreeChatHandler;
  createHostedWorkspaceSession: typeof createHostedWorkspaceSessionHandler;
} {
  return {
    createWorktreeChat: createWorktreeChatHandler,
    createHostedWorkspaceSession: createHostedWorkspaceSessionHandler,
  };
}
