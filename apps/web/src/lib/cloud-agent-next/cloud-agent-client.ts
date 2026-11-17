import type { CloudSessionMessagesWirePage } from '@kilocode/cloud-agent-sdk/schemas';
import {
  backgroundActivityInventorySchema,
  type BackgroundActivityInventory,
} from '@kilocode/session-ingest-contracts';
import {
  cloudToolPartDetailInputSchema,
  cloudToolPartDetailWireSchema,
  type CloudToolPartDetailInput,
  type CloudToolPartDetailWire,
} from '@kilocode/cloud-agent-sdk/tool-part-detail';
import 'server-only';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { type TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import * as z from 'zod';
import type { AgentConfig } from '@kilocode/db/schema-types';
import type { GateThreshold } from '@kilocode/app-shared/code-review';
import type { EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import {
  GetEgressAuditResponseSchema,
  type GetEgressAuditInput as EgressAuditPagination,
  type GetEgressAuditResponse,
} from '@kilocode/worker-utils/egress-audit';
import {
  sandboxSelectionCapabilitiesSchema,
  type SandboxAllocationInput,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { EncryptedEnvelope } from '@kilocode/web-shared/lib/encryption';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { parseCustomerBillingFailure, type PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import {
  cloudSessionMessagesPageInputSchema,
  cloudSessionMessagesPageWireSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import {
  WORKTREE_MEMBERSHIP_CHANGED,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import {
  getWorktreeChangesOutputSchema,
  getWorktreeFileOutputSchema,
  refreshWorktreeChangesOutputSchema,
  type GetWorktreeChangesOutput,
  type GetWorktreeFileOutput,
  type RefreshWorktreeChangesOutput,
  type WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  deleteWorkspaceArtifactOutputSchema,
  getWorkspaceArtifactDownloadUrlOutputSchema,
  listWorkspaceArtifactsOutputSchema,
  type DeleteWorkspaceArtifactOutput,
  type GetWorkspaceArtifactDownloadUrlOutput,
  type ListWorkspaceArtifactsOutput,
} from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';
import type { SendMessagePayload } from './types.js';
import type { WorktreeBranchOperationResult } from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import {
  baseGetMessageResultNextOutputSchema,
  baseListPreviewServicesNextOutputSchema,
  type baseGetSessionNextOutputSchema,
  type ListPreviewServicesOutput,
  workerPreviewOptionsSchema,
} from '@/routers/cloud-agent-next-schemas';
import {
  SandboxStatusSnapshotSchema,
  type SandboxStatusSnapshot,
} from '@cloud-agent-shared/sandbox-status';
import {
  environmentBuildCancelResultSchema,
  environmentBuildLogsSchema,
  environmentBuildRequestResultSchema,
  environmentBuildStatusSchema,
  type EnvironmentBuildCancelResult,
  type EnvironmentBuildLogs,
  type EnvironmentBuildRequestResult,
  type EnvironmentBuildStatus,
} from '@cloud-agent-shared/environment-build-status';
import type { PreviewTarget } from '@cloud-agent-shared/preview-target';
import { readCloudAgentErrorFields } from '@kilocode/app-shared/cloud-agent-error';
import { isTRPCErrorCode } from './cloud-agent-error';
export type { SendMessagePayload } from './types.js';

const CLOUD_AGENT_NEXT_API_URL = getEnvVariable('CLOUD_AGENT_NEXT_API_URL') || '';

// MCP server config types — CLI-native local/remote format.
// Each env/header value is either a plain string (passed through verbatim)
// or an RSA+AES envelope (decrypted per-value by the worker when
// materializing `KILO_CONFIG_CONTENT.mcp`). Callers mix the two per key:
// secrets travel as envelopes, non-sensitive config as plain strings.
type MCPSecretValue = string | EncryptedEnvelope;

type MCPLocalServerConfig = {
  type: 'local';
  command: string[];
  environment?: Record<string, MCPSecretValue>;
  enabled?: boolean;
  timeout?: number;
};

type MCPRemoteServerConfig = {
  type: 'remote';
  url: string;
  headers?: Record<string, MCPSecretValue>;
  enabled?: boolean;
  timeout?: number;
};

type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

/** Runtime skill materialized into the sandbox. `rawMarkdown` is written verbatim to SKILL.md;
 * `files` holds companion files keyed by relative path (excluding SKILL.md). */
export type RuntimeSkillInput = {
  name: string;
  rawMarkdown: string;
  files?: Record<string, string>;
};

/**
 * Custom kilo agent materialized into `KILO_CONFIG_CONTENT.agent.<slug>`.
 * Mirrors the CLI's AgentConfig shape from `@kilocode/db/schema-types`.
 */
export type RuntimeAgentInput = {
  slug: string;
  name: string;
  config: AgentConfig;
};

/**
 * Type definitions for cloud-agent-next API procedures
 */

/** Callback target configuration for execution completion notifications */
export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

/**
 * Agent slug selected for a session. Built-in slugs plus `custom` plus any
 * custom slug defined in the session's `runtimeAgents`.
 *
 * - code, plan, debug, orchestrator, ask: built-in agents
 * - build, architect: Backward-compatible aliases (build → code, architect → plan)
 * - custom: one-off mode (requires appendSystemPrompt)
 * - any other slug: must match a slug in this session's runtimeAgents
 *
 * Kept as `AgentMode` rather than `AgentSlug` to avoid a cross-cutting rename
 * of the API-level `mode` field.
 */
export type AgentMode = string;

/** Shared fields for prepareSession, present on both the non-clone and clone variants. */
type PrepareSessionSharedFields = {
  githubAccessPurpose?: 'workflow' | 'agent';
  mode: AgentMode;
  model: string;
  variant?: string;
  githubRepo?: string;
  githubIntegrationId?: string;
  /** GitHub Personal Access Token for private repositories */
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  /** Explicit platform type for correct env var setup (avoids URL-based detection) */
  platform?: 'github' | 'gitlab' | 'bitbucket';
  bitbucketWorkspaceUuid?: string;
  bitbucketRepositoryUuid?: string;
  kilocodeOrganizationId?: string;
  /** The repository environment the user selected, with branches for its additional repositories. */
  requestedEnvironment?: {
    id: string;
    repositories?: { repoFullName: string; branch?: string }[];
  };
  /** Set by a client that shows an environment picker; see the worker's `requireEnvironmentChoice`. */
  requireEnvironmentChoice?: true;
  /** Profile ID forwarded to cloud-agent-next for server-side merge. */
  profileId?: string;
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  /**
   * Runtime skills materialized from the merged profile stack. The worker
   * writes each entry's SKILL.md (and any companion files) to
   * `${SESSION_HOME}/.kilocode/skills/<name>/`.
   */
  runtimeSkills?: RuntimeSkillInput[];
  /** Custom agents materialized from the merged profile stack. */
  runtimeAgents?: RuntimeAgentInput[];
  upstreamBranch?: string;
  /** Start a new branch from this base instead of the repository default. */
  baseBranch?: string;
  /** Resolved commit for `baseBranch`; never accepted from a browser. */
  baseSha?: string;
  /** The parent worktree when this session starts from another worktree. */
  parentWorktreeId?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt (required when mode is 'custom') */
  appendSystemPrompt?: string;
  /** Canonical Cloud Agent attachments for the prompt */
  attachments?: CloudAgentAttachments;
  /** Callback configuration for execution completion events */
  callbackTarget?: CallbackTarget;
  /** Platform that created this session (e.g. 'security-agent', 'slack') */
  createdOnPlatform?: string;
  clientProvenance?: 'browser' | 'mobile';
  /** PR gate threshold — when not 'off', the agent reports gateResult in its callback */
  gateThreshold?: GateThreshold;
  /** Deprecated: true is rejected because devcontainer support is retired. */
  devcontainer?: boolean;
  sandboxAllocation?: SandboxAllocationInput;
  egressMode?: EgressMode;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

/** Non-clone prepare input: required `prompt` and the current optional initial fields. */
export type PrepareSessionNonCloneInput = PrepareSessionSharedFields & {
  prompt: string;
  initialPayload?: SendMessagePayload;
  initialMessageId?: string | null;
  /** When true, return immediately and run preparation asynchronously */
  autoInitiate?: boolean;
  /** Stable per-user-intent UUID; with `autoInitiate`, dedupes retries in the operation ledger. */
  operationKey?: string;
  /** Client-proposed Kilo session ID, so the client can show the session before prepare returns. */
  kiloSessionId?: string;
  cloneFromKiloSessionId?: undefined;
  cloneUpToMessageId?: undefined;
};

/** Clone-only prepare input: copies the source session and forbids a synthetic initial turn. */
export type PrepareSessionCloneInput = PrepareSessionSharedFields & {
  cloneFromKiloSessionId: string;
  /** Inclusive cut: copy source messages up to and including this ID. */
  cloneUpToMessageId?: string;
  autoInitiate: true;
  operationKey: string;
};

/** Input for prepareSession procedure */
export type PrepareSessionInput = PrepareSessionNonCloneInput | PrepareSessionCloneInput;

export type GetSandboxSelectionOptionsInput = {
  kilocodeOrganizationId?: string;
  devcontainer?: boolean;
  repositoryType?: 'github' | 'gitlab' | 'bitbucket' | 'git';
  /** With `repositoryType`, resolves saved repository overrides into `effectiveDestination`. */
  repositoryFullName?: string;
};

/** Output from prepareSession procedure */
export type PrepareSessionOutput = {
  /** The Kilo CLI session ID */
  kiloSessionId: string;
  cloudAgentSessionId: string;
  worktreeId?: CloudAgentWorktreeId;
  /** `true` when the response replays an already-settled create for the same `operationKey`. */
  replayed?: boolean;
};

export type CreateWorktreeChatInput = {
  sourceKiloSessionId: string;
  sourceCloudAgentSessionId: string;
  operationKey: string;
  kiloSessionId?: string;
  kilocodeOrganizationId?: string;
  clientProvenance: 'browser';
};

export type CreateWorktreeChatOutput = {
  kiloSessionId: string;
  cloudAgentSessionId: `workspace_${string}`;
  worktreeId: CloudAgentWorktreeId;
  replayed?: boolean;
};

export type DeleteWorktreeInput = {
  worktreeId: CloudAgentWorktreeId;
  kilocodeOrganizationId?: string;
  onlyIfSoleSessionId?: string;
};

const deleteWorktreeOutputSchema = z.object({
  success: z.literal(true),
  deletedSessionIds: z.array(z.string()),
  cleanup: z.enum(['complete', 'pending']).default('complete'),
});

export type DeleteWorktreeOutput = z.infer<typeof deleteWorktreeOutputSchema>;

/** Input for initiating from a prepared session */
export type InitiateFromPreparedSessionInput = {
  cloudAgentSessionId: string;
};

/** Input for sendMessage procedure (V2 - uses cloudAgentSessionId) */
export type SendMessageInput = {
  cloudAgentSessionId: string;
  payload: SendMessagePayload;
  autoCommit?: boolean;
  organizationId?: string;
  githubToken?: string;
  gitToken?: string;
  /** Canonical Cloud Agent attachments for the message */
  attachments?: CloudAgentAttachments;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;
  /** Message ID for correlating the request */
  messageId?: string | null;
};

export type TerminalPty = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

export type CreateTerminalInput = {
  cloudAgentSessionId: string;
  cols?: number;
  rows?: number;
};

export type CreateTerminalOutput = {
  pty: TerminalPty;
};

export type ResizeTerminalInput = {
  cloudAgentSessionId: string;
  ptyId: string;
  cols: number;
  rows: number;
};

export type ResizeTerminalOutput = {
  pty: TerminalPty;
};

export type CloseTerminalInput = {
  cloudAgentSessionId: string;
  ptyId: string;
};

export type CloseTerminalOutput = {
  success: boolean;
};

/** Output from V2 mutation procedures (WebSocket-based) */
export type InitiateSessionOutput = {
  cloudAgentSessionId: string;
  executionId: string;
  status: 'started';
  streamUrl: string;
  messageId: string;
  delivery: 'sent' | 'queued';
};

/** Input for getSession procedure */
export type GetSessionInput = {
  cloudAgentSessionId: string;
  organizationId?: string;
};

export type ListChildSessionsInput = {
  limit: number;
  cursor?: string;
  organizationId?: string;
};

export type ListChildSessionsOutput = {
  sessions: Array<{
    cloudAgentSessionId: string;
    initialMessageId?: string;
    worktreeId?: CloudAgentWorktreeId;
  }>;
  nextCursor?: string;
};

export type GetSessionMessagesPageInput = z.input<typeof cloudSessionMessagesPageInputSchema>;

/** Input for syncWorktreeBranch; the base and fork boundary are resolved server-side. */
export type SyncWorktreeBranchInput = {
  cloudAgentSessionId: string;
  baseBranch?: string;
  upstreamSha?: string;
};

/** Input for restackWorktreeBranch; the target base and upstream are resolved server-side. */
export type RestackWorktreeBranchInput = {
  cloudAgentSessionId: string;
  baseBranch?: string;
  upstreamSha?: string;
};

/** Adopts a persisted worktree base into a sibling session's DO metadata. */
export type AdoptWorktreeBaseInput = {
  cloudAgentSessionId: string;
  expectedWorktreeId: string;
  baseBranch: string;
  baseSha: string;
};

export type AdoptWorktreeBaseOutput = { success: true };

/** Interactions a cloud-agent session currently waits on. */
export type GetPendingInteractionsOutput = {
  questions: unknown[];
  permissions: unknown[];
};

export type GetWorktreeFileInput = GetSessionInput & WorktreeFileQuery;

export type GetEgressAuditInput = GetSessionInput & EgressAuditPagination;

/** The preview target plus the route organization the Worker uses for its UI gate. */
export type GetPreviewOptionsInput = PreviewTarget & { organizationId?: string };

/** One environment, under the caller's user or the given organization. */
export type EnvironmentBuildScope = {
  environmentId: string;
  kilocodeOrganizationId?: string;
};

export type EnvironmentBuildRequestInput = EnvironmentBuildScope & {
  expectedRevision: number;
  requestId: string;
};

export type EnvironmentBuildLogsInput = EnvironmentBuildScope & {
  buildId: string;
  cursor?: number;
  limit: number;
};

export type EnvironmentBuildCancelInput = EnvironmentBuildScope & { buildId: string };

/** Output from getSession procedure. Its shape is the shared schema, not a hand-written twin. */
export type GetSessionOutput = z.infer<typeof baseGetSessionNextOutputSchema>;

/**
 * Input for updateSession procedure.
 * Updates a prepared (but not yet initiated) session.
 * - undefined: skip field (no change)
 * - null: clear field
 * - value: set field to value
 * - For collections, empty array/object clears them
 */
export type UpdateSessionInput = {
  cloudAgentSessionId: string;
  mode?: AgentMode | null;
  model?: string | null;
  variant?: string | null;
  githubToken?: string | null;
  gitToken?: string | null;
  upstreamBranch?: string | null;
  autoCommit?: boolean | null;
  condenseOnComplete?: boolean | null;
  appendSystemPrompt?: string | null;
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  runtimeSkills?: RuntimeSkillInput[];
  runtimeAgents?: RuntimeAgentInput[];
  callbackTarget?: CallbackTarget | null;
};

/** Output from updateSession procedure */
export type UpdateSessionOutput = {
  success: boolean;
};

/** Result of interrupting a session */
export type InterruptResult = {
  success: boolean;
  message: string;
  processesFound: boolean;
};

/** Input for canceling one queued (not yet accepted) message. */
export type CancelQueuedMessageInput = {
  sessionId: string;
  messageId: string;
};

export type AnswerQuestionInput = {
  sessionId: string;
  questionId: string;
  answers: string[][];
};

export type RejectQuestionInput = {
  sessionId: string;
  questionId: string;
};

export type AnswerPermissionInput = {
  sessionId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
};

/** Output from health procedure */
export type HealthOutput = {
  status: string;
  timestamp: string;
  version: string;
};

/**
 * Custom error class for payment-related errors from cloud-agent.
 */
export class InsufficientCreditsError extends Error {
  readonly httpStatus = 402;
  readonly code = 'PAYMENT_REQUIRED';

  constructor(message = 'Insufficient credits: $1 minimum required') {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

export class CloudAgentBillingError extends Error {
  constructor(
    readonly billingFailure: NonNullable<ReturnType<typeof parseCustomerBillingFailure>>,
    readonly httpStatus: 402 | 409 | 503
  ) {
    super('Cloud Agent compute billing request was not accepted');
    this.name = 'CloudAgentBillingError';
  }
}

/**
 * The worker answers these six codes, and a 404, to a delete the caller may
 * report itself instead of swallowing.
 */
const DELETE_SESSION_VISIBLE_CODES = new Set<TRPC_ERROR_CODE_KEY>([
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'PRECONDITION_FAILED',
  'BAD_REQUEST',
]);

function isDeleteSessionFailureVisible(error: unknown): boolean {
  const { code, httpStatus } = readCloudAgentErrorFields(error);
  if (httpStatus === 404) return true;
  return code !== undefined && isTRPCErrorCode(code) && DELETE_SESSION_VISIBLE_CODES.has(code);
}

/**
 * Re-throws a Cloud Agent error as a TRPCError for the web tRPC response.
 * Billing errors keep their billing status. A worker 4xx error keeps its tRPC
 * code and message; tRPC reports any other error as a 500.
 */
export function rethrowCloudAgentError(error: unknown): never {
  if (error instanceof CloudAgentBillingError) {
    throw new TRPCError({
      code:
        error.httpStatus === 402
          ? 'PAYMENT_REQUIRED'
          : error.httpStatus === 409
            ? 'CONFLICT'
            : 'SERVICE_UNAVAILABLE',
      message: error.message,
      cause: { billingFailure: error.billingFailure },
    });
  }
  if (error instanceof InsufficientCreditsError) {
    throw new TRPCError({
      code: 'PAYMENT_REQUIRED',
      message: error.message,
    });
  }
  if (error instanceof TRPCClientError) {
    const { code } = readCloudAgentErrorFields(error);
    if (code !== undefined && isTRPCErrorCode(code)) {
      const workerError = new TRPCError({ code, message: error.message, cause: error });
      if (getHTTPStatusCodeFromError(workerError) < 500) {
        throw workerError;
      }
    }
  }
  throw error;
}

/**
 * Check if an error indicates insufficient credits (402 Payment Required).
 */
function isInsufficientCreditsError(err: unknown): boolean {
  if (parseCustomerBillingFailure(err)) return false;
  if (err instanceof TRPCClientError) {
    const { httpStatus } = readCloudAgentErrorFields(err);
    if (httpStatus === 402) {
      return true;
    }
    const cause = err.cause as {
      error?: { status?: number };
      suppressed?: { status?: number };
    };
    if (cause?.error?.status === 402 || cause?.suppressed?.status === 402) {
      return true;
    }
  }
  return false;
}

function preserveBillingFailure(error: unknown): void {
  const billingFailure = parseCustomerBillingFailure(error);
  if (!billingFailure) return;
  const status =
    error instanceof TRPCClientError ? readCloudAgentErrorFields(error).httpStatus : undefined;
  throw new CloudAgentBillingError(
    billingFailure,
    status === 402 || status === 409 || status === 503 ? status : 503
  );
}

function normalizeCloudAgentProtocolError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (!error.message.includes('is not valid JSON')) {
    return error;
  }

  const normalized = new Error('Cloud agent returned a non-JSON error response', { cause: error });
  normalized.name = 'CloudAgentProtocolError';
  return normalized;
}

/**
 * Minimal TRPC client interface for cloud-agent-next API
 * Note: This uses only V2 procedures (WebSocket streaming)
 */
type CloudAgentNextTRPCClient = {
  health: {
    query: () => Promise<HealthOutput>;
  };
  deleteSession: {
    mutate: (input: { sessionId: string }) => Promise<{ success: boolean; message?: string }>;
  };
  removeWorkspaceSnapshot: {
    mutate: (input: { sessionId: string }) => Promise<{ success: true }>;
  };
  getWorkspaceSnapshotRecovery: {
    query: (input: { sessionId: string }) => Promise<{ capturedAt: number | null } | null>;
  };
  deleteHostedWorkspaceSession: {
    mutate: (input: { workspaceId: string; sessionId: string; operationKey: string }) => Promise<{
      success: true;
      workspaceId: string;
      sessionId: string;
      cleanup: 'complete' | 'pending';
    }>;
  };
  deleteWorktree: {
    mutate: (input: DeleteWorktreeInput) => Promise<DeleteWorktreeOutput>;
  };
  cleanupSession: {
    mutate: (input: { sessionId: string }) => Promise<{ success: boolean; message?: string }>;
  };
  interruptSession: {
    mutate: (input: { sessionId: string; organizationId?: string }) => Promise<InterruptResult>;
  };
  cancelQueuedMessage: {
    mutate: (input: CancelQueuedMessageInput) => Promise<{ dropped: boolean }>;
  };
  getSession: {
    query: (input: GetSessionInput) => Promise<GetSessionOutput>;
  };
  getSessionMessagesPage: {
    query: (input: GetSessionMessagesPageInput) => Promise<unknown>;
  };
  getBackgroundActivity: {
    query: (input: GetSessionInput) => Promise<unknown>;
  };
  getSessionToolPartDetail: {
    query: (input: CloudToolPartDetailInput) => Promise<unknown>;
  };
  getSandboxStatus: {
    query: (input: GetSessionInput) => Promise<unknown>;
  };
  getPreparationAttempts: {
    query: (input: GetSessionInput) => Promise<PreparationAttempt[]>;
  };
  getEgressAudit: {
    query: (input: GetEgressAuditInput) => Promise<unknown>;
  };
  getPendingInteractions: {
    query: (input: GetSessionInput) => Promise<GetPendingInteractionsOutput>;
  };
  getWorktreeChanges: {
    query: (input: GetSessionInput) => Promise<unknown>;
  };
  refreshWorktreeChanges: {
    mutate: (input: GetSessionInput) => Promise<unknown>;
  };
  getWorktreeFile: {
    query: (input: GetWorktreeFileInput) => Promise<unknown>;
  };
  syncWorktreeBranch: {
    mutate: (input: SyncWorktreeBranchInput) => Promise<WorktreeBranchOperationResult>;
  };
  restackWorktreeBranch: {
    mutate: (input: RestackWorktreeBranchInput) => Promise<WorktreeBranchOperationResult>;
  };
  adoptWorktreeBase: {
    mutate: (input: AdoptWorktreeBaseInput) => Promise<AdoptWorktreeBaseOutput>;
  };
  listWorkspaceArtifacts: {
    query: (input: { cloudAgentSessionId: string }) => Promise<unknown>;
  };
  getWorkspaceArtifactDownloadUrl: {
    query: (input: { cloudAgentSessionId: string; relativePath: string }) => Promise<unknown>;
  };
  deleteWorkspaceArtifact: {
    mutate: (input: {
      cloudAgentSessionId: string;
      relativePath: string;
      expectedHash: string;
    }) => Promise<unknown>;
  };
  getSandboxSelectionOptions: {
    query: (input: GetSandboxSelectionOptionsInput) => Promise<SandboxSelectionCapabilities>;
  };
  getPreviewOptions: {
    query: (input: GetPreviewOptionsInput) => Promise<unknown>;
  };
  listPreviewServices: {
    query: (input: GetPreviewOptionsInput) => Promise<unknown>;
  };
  prepareSession: {
    mutate: (input: PrepareSessionInput) => Promise<PrepareSessionOutput>;
  };
  createWorktreeChat: {
    mutate: (input: CreateWorktreeChatInput) => Promise<CreateWorktreeChatOutput>;
  };
  updateSession: {
    mutate: (input: UpdateSessionInput) => Promise<UpdateSessionOutput>;
  };
  initiateFromKilocodeSessionV2: {
    mutate: (input: InitiateFromPreparedSessionInput) => Promise<InitiateSessionOutput>;
  };
  sendMessageV2: {
    mutate: (input: SendMessageInput) => Promise<InitiateSessionOutput>;
  };
  getMessageResult: {
    query: (input: {
      cloudAgentSessionId: string;
      messageId: string;
      organizationId?: string;
    }) => Promise<unknown>;
  };
  listChildSessions: {
    query: (input: ListChildSessionsInput) => Promise<ListChildSessionsOutput>;
  };
  createTerminal: {
    mutate: (input: CreateTerminalInput) => Promise<CreateTerminalOutput>;
  };
  resizeTerminal: {
    mutate: (input: ResizeTerminalInput) => Promise<ResizeTerminalOutput>;
  };
  closeTerminal: {
    mutate: (input: CloseTerminalInput) => Promise<CloseTerminalOutput>;
  };
  answerQuestion: {
    mutate: (input: AnswerQuestionInput) => Promise<{ success: boolean }>;
  };
  rejectQuestion: {
    mutate: (input: RejectQuestionInput) => Promise<{ success: boolean }>;
  };
  answerPermission: {
    mutate: (input: AnswerPermissionInput) => Promise<{ success: boolean }>;
  };
  buildEnvironment: {
    mutate: (input: EnvironmentBuildRequestInput) => Promise<unknown>;
  };
  getEnvironmentBuildStatus: {
    query: (input: EnvironmentBuildScope) => Promise<unknown>;
  };
  getEnvironmentBuildLogs: {
    query: (input: EnvironmentBuildLogsInput) => Promise<unknown>;
  };
  cancelEnvironmentBuild: {
    mutate: (input: EnvironmentBuildCancelInput) => Promise<unknown>;
  };
  notifyEnvironmentDeleted: {
    mutate: (input: { environmentId: string }) => Promise<unknown>;
  };
};

/**
 * Options for configuring the cloud agent client
 */
export type CloudAgentNextClientOptions = {
  /**
   * Skip balance validation in cloud-agent for free/BYOK model sessions.
   */
  skipBalanceCheck?: boolean;
};

/**
 * Client for communicating with the cloud-agent-next TRPC API
 *
 * This client only uses the V2 WebSocket-based API with mutation procedures.
 * Streaming is handled separately via WebSocketManager.
 */
export class CloudAgentNextClient {
  private client: CloudAgentNextTRPCClient;
  private authToken: string;
  private options: CloudAgentNextClientOptions;

  constructor(authToken: string, options: CloudAgentNextClientOptions = {}) {
    this.authToken = authToken;
    this.options = options;

    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
    };
    if (this.options.skipBalanceCheck) {
      baseHeaders['x-skip-balance-check'] = 'true';
    }

    // Create TRPC client - only uses httpLink for mutations/queries
    // (streaming is handled via WebSocketManager)
    this.client = createTRPCClient({
      links: [
        httpLink({
          url: `${CLOUD_AGENT_NEXT_API_URL}/trpc`,
          headers: () => ({
            ...baseHeaders,
            'x-internal-api-key': INTERNAL_API_SECRET,
          }),
        }),
      ],
    }) as unknown as CloudAgentNextTRPCClient;
  }

  private async request<T>(
    endpoint: string,
    operation: () => Promise<T>,
    extra?: Record<string, unknown>
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint },
        ...(extra === undefined ? {} : { extra }),
      });
      throw error;
    }
  }

  /**
   * Check health status of the cloud agent API
   */
  async health(): Promise<HealthOutput> {
    return this.request('health', () => this.client.health.query());
  }

  /**
   * Delete a session from the cloud agent.
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      const result = await this.client.deleteSession.mutate({ sessionId });
      return { success: result.success };
    } catch (error) {
      // The calling surfaces show these failures to the user; anything else is
      // logged and reported as a non-destructive `success: false`.
      if (error instanceof TRPCClientError && isDeleteSessionFailureVisible(error)) {
        throw error;
      }

      console.error(`Error deleting session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'deleteSession' },
        extra: { sessionId },
      });
      return { success: false };
    }
  }

  /**
   * Remove the session's workspace snapshot so its next start uses the
   * environment snapshot or the base image. This discards workspace changes
   * made since the snapshot was captured.
   */
  async removeWorkspaceSnapshot(sessionId: string): Promise<{ success: true }> {
    return this.request(
      'removeWorkspaceSnapshot',
      () => this.client.removeWorkspaceSnapshot.mutate({ sessionId }),
      { sessionId }
    );
  }

  /**
   * The capture time of the session's workspace snapshot, or null when the
   * workspace has none. A non-null value is what makes "Start fresh" available.
   */
  async getWorkspaceSnapshotRecovery(
    sessionId: string
  ): Promise<{ capturedAt: number | null } | null> {
    return this.request(
      'getWorkspaceSnapshotRecovery',
      () => this.client.getWorkspaceSnapshotRecovery.query({ sessionId }),
      { sessionId }
    );
  }

  async deleteHostedWorkspaceSession(input: {
    workspaceId: string;
    sessionId: string;
    operationKey: string;
  }): Promise<{
    success: true;
    workspaceId: string;
    sessionId: string;
    cleanup: 'complete' | 'pending';
  }> {
    return this.client.deleteHostedWorkspaceSession.mutate(input);
  }

  async deleteWorktree(input: DeleteWorktreeInput): Promise<DeleteWorktreeOutput> {
    try {
      return deleteWorktreeOutputSchema.parse(await this.client.deleteWorktree.mutate(input));
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.message === WORKTREE_MEMBERSHIP_CHANGED &&
        (error.data?.code === 'CONFLICT' || error.shape?.data?.code === 'CONFLICT')
      ) {
        throw error;
      }
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'deleteWorktree' },
        extra: { worktreeId: input.worktreeId },
      });
      throw error;
    }
  }

  /**
   * Clean up a caller-created session and classify its runtime deletion as caller cleanup.
   */
  async cleanupSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      const result = await this.client.cleanupSession.mutate({ sessionId });
      return { success: result.success };
    } catch (error) {
      console.error(`Error cleaning up session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'cleanupSession' },
        extra: { sessionId },
      });
      return { success: false };
    }
  }

  /**
   * Interrupt a running session by killing all associated kilocode processes.
   */
  async interruptSession(sessionId: string, organizationId?: string): Promise<InterruptResult> {
    try {
      const result = await this.client.interruptSession.mutate({
        sessionId,
        ...(organizationId === undefined ? {} : { organizationId }),
      });
      return result;
    } catch (error) {
      console.error(`Error interrupting session ${sessionId}:`, error);
      captureException(error, {
        tags: {
          source: 'cloud-agent-next-client',
          endpoint: 'interruptSession',
        },
        extra: { sessionId },
      });
      throw error;
    }
  }

  /**
   * Cancel one queued (not yet accepted) message by id without interrupting the
   * active run. Returns whether a pending message was dropped.
   */
  async cancelQueuedMessage(sessionId: string, messageId: string): Promise<{ dropped: boolean }> {
    try {
      return await this.client.cancelQueuedMessage.mutate({ sessionId, messageId });
    } catch (error) {
      console.error(`Error canceling queued message ${messageId} in session ${sessionId}:`, error);
      captureException(error, {
        tags: {
          source: 'cloud-agent-next-client',
          endpoint: 'cancelQueuedMessage',
        },
        extra: { sessionId, messageId },
      });
      throw error;
    }
  }

  /**
   * Get session state from cloud-agent DO.
   */
  async getSession(
    cloudAgentSessionId: string,
    organizationId?: string
  ): Promise<GetSessionOutput> {
    return this.request(
      'getSession',
      () =>
        this.client.getSession.query({
          cloudAgentSessionId,
          ...(organizationId === undefined ? {} : { organizationId }),
        }),
      { cloudAgentSessionId }
    );
  }

  async listChildSessions(input: ListChildSessionsInput): Promise<ListChildSessionsOutput> {
    return this.request('listChildSessions', () => this.client.listChildSessions.query(input), {
      limit: input.limit,
      cursor: input.cursor,
      organizationId: input.organizationId,
    });
  }

  async getSessionMessagesPage(
    input: GetSessionMessagesPageInput
  ): Promise<CloudSessionMessagesWirePage> {
    const request = cloudSessionMessagesPageInputSchema.parse(input);
    return cloudSessionMessagesPageWireSchema.parse(
      await this.client.getSessionMessagesPage.query(request)
    );
  }

  async getBackgroundActivity(
    cloudAgentSessionId: string
  ): Promise<BackgroundActivityInventory | null> {
    const result = await this.client.getBackgroundActivity.query({ cloudAgentSessionId });
    return result === null ? null : backgroundActivityInventorySchema.parse(result);
  }

  async getSessionToolPartDetail(
    input: CloudToolPartDetailInput
  ): Promise<CloudToolPartDetailWire> {
    const request = cloudToolPartDetailInputSchema.parse(input);
    return cloudToolPartDetailWireSchema.parse(
      await this.client.getSessionToolPartDetail.query(request)
    );
  }

  /** The session's preparation attempts, as its stream replays them. */
  async getPreparationAttempts(cloudAgentSessionId: string): Promise<PreparationAttempt[]> {
    return this.request(
      'getPreparationAttempts',
      () => this.client.getPreparationAttempts.query({ cloudAgentSessionId }),
      { cloudAgentSessionId }
    );
  }

  async getSandboxStatus(cloudAgentSessionId: string): Promise<SandboxStatusSnapshot> {
    try {
      return SandboxStatusSnapshotSchema.parse(
        await this.client.getSandboxStatus.query({ cloudAgentSessionId })
      );
    } catch (error) {
      if (error instanceof TRPCClientError) {
        const code = error.data?.code ?? error.shape?.data?.code;
        const httpStatus = error.data?.httpStatus ?? error.shape?.data?.httpStatus;
        if (code === 'UNAUTHORIZED' || httpStatus === 401) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
        }
        if (
          code === 'FORBIDDEN' ||
          code === 'NOT_FOUND' ||
          httpStatus === 403 ||
          httpStatus === 404
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Session not found or access denied' });
        }
        if (code === 'SERVICE_UNAVAILABLE' || httpStatus === 503) {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Sandbox status is temporarily unavailable',
          });
        }
      }
      return {
        status: 'unknown',
        provider: 'Unknown',
        observedAt: Date.now(),
        detailCode: 'status_unavailable',
        inactivityTimeoutMs: null,
        estimatedSleepAt: null,
      };
    }
  }

  async getWorktreeChanges(cloudAgentSessionId: string): Promise<GetWorktreeChangesOutput> {
    return getWorktreeChangesOutputSchema.parse(
      await this.client.getWorktreeChanges.query({ cloudAgentSessionId })
    );
  }

  async getEgressAudit(input: GetEgressAuditInput): Promise<GetEgressAuditResponse> {
    try {
      return GetEgressAuditResponseSchema.parse(await this.client.getEgressAudit.query(input));
    } catch (error) {
      rethrowCloudAgentError(error);
    }
  }

  async refreshWorktreeChanges(cloudAgentSessionId: string): Promise<RefreshWorktreeChangesOutput> {
    return refreshWorktreeChangesOutputSchema.parse(
      await this.client.refreshWorktreeChanges.mutate({ cloudAgentSessionId })
    );
  }

  async getWorktreeFile(input: GetWorktreeFileInput): Promise<GetWorktreeFileOutput> {
    let response: unknown;
    try {
      response = await this.client.getWorktreeFile.query(input);
    } catch {
      throw new Error('Saved worktree file request failed');
    }
    const parsed = getWorktreeFileOutputSchema.safeParse(response);
    if (!parsed.success) throw new Error('Invalid saved worktree file response');
    const result = parsed.data;
    if (
      (result.status === 'available' || result.status === 'omitted') &&
      (result.file.path !== input.path ||
        result.file.revision !== input.expectedRevision ||
        (input.scope !== undefined && result.file.scope !== input.scope))
    ) {
      throw new Error('Saved worktree file does not match the query');
    }
    return result;
  }

  async syncWorktreeBranch(input: SyncWorktreeBranchInput): Promise<WorktreeBranchOperationResult> {
    return await this.client.syncWorktreeBranch.mutate(input);
  }

  async restackWorktreeBranch(
    input: RestackWorktreeBranchInput
  ): Promise<WorktreeBranchOperationResult> {
    return await this.client.restackWorktreeBranch.mutate(input);
  }

  async adoptWorktreeBase(input: AdoptWorktreeBaseInput): Promise<AdoptWorktreeBaseOutput> {
    return await this.client.adoptWorktreeBase.mutate(input);
  }

  async listWorkspaceArtifacts(cloudAgentSessionId: string): Promise<ListWorkspaceArtifactsOutput> {
    return listWorkspaceArtifactsOutputSchema.parse(
      await this.client.listWorkspaceArtifacts.query({ cloudAgentSessionId })
    );
  }

  async getWorkspaceArtifactDownloadUrl(
    cloudAgentSessionId: string,
    relativePath: string
  ): Promise<GetWorkspaceArtifactDownloadUrlOutput> {
    return getWorkspaceArtifactDownloadUrlOutputSchema.parse(
      await this.client.getWorkspaceArtifactDownloadUrl.query({
        cloudAgentSessionId,
        relativePath,
      })
    );
  }

  async deleteWorkspaceArtifact(input: {
    cloudAgentSessionId: string;
    relativePath: string;
    expectedHash: string;
  }): Promise<DeleteWorkspaceArtifactOutput> {
    return deleteWorkspaceArtifactOutputSchema.parse(
      await this.client.deleteWorkspaceArtifact.mutate(input)
    );
  }

  async createWorktreeChat(input: CreateWorktreeChatInput): Promise<CreateWorktreeChatOutput> {
    return this.request('createWorktreeChat', () => this.client.createWorktreeChat.mutate(input), {
      sourceKiloSessionId: input.sourceKiloSessionId,
      sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
    });
  }

  async getSandboxSelectionOptions(
    input: GetSandboxSelectionOptionsInput
  ): Promise<SandboxSelectionCapabilities> {
    return sandboxSelectionCapabilitiesSchema.parse(
      await this.client.getSandboxSelectionOptions.query(input)
    );
  }

  async getPreviewOptions(
    input: GetPreviewOptionsInput
  ): Promise<z.infer<typeof workerPreviewOptionsSchema>> {
    return workerPreviewOptionsSchema.parse(await this.client.getPreviewOptions.query(input));
  }

  async listPreviewServices(input: GetPreviewOptionsInput): Promise<ListPreviewServicesOutput> {
    return baseListPreviewServicesNextOutputSchema.parse(
      await this.client.listPreviewServices.query(input)
    );
  }

  /**
   * Prepare a new cloud agent session.
   */
  async prepareSession(input: PrepareSessionInput): Promise<PrepareSessionOutput> {
    console.log('[CloudAgentNextClient.prepareSession] Starting request', {
      githubRepo: input.githubRepo,
      gitUrl: input.gitUrl,
      kilocodeOrganizationId: input.kilocodeOrganizationId,
      mode: input.mode,
      model: input.model,
    });
    const startTime = Date.now();
    try {
      const result = await this.client.prepareSession.mutate(input);
      console.log('[CloudAgentNextClient.prepareSession] Request completed', {
        elapsed: Date.now() - startTime,
        kiloSessionId: result.kiloSessionId,
        cloudAgentSessionId: result.cloudAgentSessionId,
      });
      return result;
    } catch (error) {
      const normalizedError = normalizeCloudAgentProtocolError(error);
      preserveBillingFailure(normalizedError);

      console.log('[CloudAgentNextClient.prepareSession] Request failed', {
        elapsed: Date.now() - startTime,
        error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      });

      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'prepareSession' },
        extra: {
          kilocodeOrganizationId: input.kilocodeOrganizationId,
          cloneFromKiloSessionId: input.cloneFromKiloSessionId,
          operationKey: input.operationKey,
          createdOnPlatform: input.createdOnPlatform,
          clientProvenance: input.clientProvenance,
          model: input.model,
          mode: input.mode,
        },
      });
      throw normalizedError;
    }
  }

  /**
   * Update a prepared (but not yet initiated) session.
   *
   * - undefined: skip field (no change)
   * - null: clear field
   * - value: set field to value
   * - For collections, empty array/object clears them
   */
  async updateSession(input: UpdateSessionInput): Promise<UpdateSessionOutput> {
    return this.request('updateSession', () => this.client.updateSession.mutate(input), {
      cloudAgentSessionId: input.cloudAgentSessionId,
    });
  }

  /**
   * Initiate a session from a prepared session using the V2 WebSocket-based API.
   *
   * Returns immediately with execution info and a WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  async initiateFromPreparedSession(
    input: InitiateFromPreparedSessionInput
  ): Promise<InitiateSessionOutput> {
    try {
      return await this.client.initiateFromKilocodeSessionV2.mutate(input);
    } catch (error) {
      const normalizedError = normalizeCloudAgentProtocolError(error);
      preserveBillingFailure(normalizedError);

      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: {
          source: 'cloud-agent-next-client',
          endpoint: 'initiateFromPreparedSession',
        },
        extra: { cloudAgentSessionId: input.cloudAgentSessionId },
      });
      throw normalizedError;
    }
  }

  /**
   * Send a message to an existing session using the V2 WebSocket-based API.
   *
   * Returns immediately with execution info and a WebSocket URL for streaming.
   * The client connects to the streamUrl separately to receive events.
   */
  async sendMessage(input: SendMessageInput): Promise<InitiateSessionOutput> {
    try {
      return await this.client.sendMessageV2.mutate(input);
    } catch (error) {
      const normalizedError = normalizeCloudAgentProtocolError(error);
      preserveBillingFailure(normalizedError);

      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'sendMessage' },
        extra: {
          cloudAgentSessionId: input.cloudAgentSessionId,
          messageId: input.messageId,
          payloadType: input.payload.type,
        },
      });
      throw normalizedError;
    }
  }

  async getMessageResult(input: {
    cloudAgentSessionId: string;
    messageId: string;
    organizationId?: string;
  }) {
    try {
      return baseGetMessageResultNextOutputSchema.parse(
        await this.client.getMessageResult.query(input)
      );
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        (error.data?.code === 'NOT_FOUND' || error.shape?.data?.code === 'NOT_FOUND') &&
        error.message === 'Message not found'
      ) {
        return null;
      }
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'getMessageResult' },
        extra: {
          cloudAgentSessionId: input.cloudAgentSessionId,
          messageId: input.messageId,
        },
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Message result unavailable',
        cause: error,
      });
    }
  }

  async createTerminal(input: CreateTerminalInput): Promise<CreateTerminalOutput> {
    return this.request('createTerminal', () => this.client.createTerminal.mutate(input), {
      cloudAgentSessionId: input.cloudAgentSessionId,
    });
  }

  async resizeTerminal(input: ResizeTerminalInput): Promise<ResizeTerminalOutput> {
    return this.request('resizeTerminal', () => this.client.resizeTerminal.mutate(input), {
      cloudAgentSessionId: input.cloudAgentSessionId,
      ptyId: input.ptyId,
    });
  }

  async closeTerminal(input: CloseTerminalInput): Promise<CloseTerminalOutput> {
    return this.request('closeTerminal', () => this.client.closeTerminal.mutate(input), {
      cloudAgentSessionId: input.cloudAgentSessionId,
      ptyId: input.ptyId,
    });
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<{ success: boolean }> {
    return this.request('answerQuestion', () => this.client.answerQuestion.mutate(input), {
      sessionId: input.sessionId,
      questionId: input.questionId,
    });
  }

  async rejectQuestion(input: RejectQuestionInput): Promise<{ success: boolean }> {
    return this.request('rejectQuestion', () => this.client.rejectQuestion.mutate(input), {
      sessionId: input.sessionId,
      questionId: input.questionId,
    });
  }

  async answerPermission(input: AnswerPermissionInput): Promise<{ success: boolean }> {
    return this.request('answerPermission', () => this.client.answerPermission.mutate(input), {
      sessionId: input.sessionId,
      permissionId: input.permissionId,
    });
  }

  async getPendingInteractions(cloudAgentSessionId: string): Promise<GetPendingInteractionsOutput> {
    return this.request(
      'getPendingInteractions',
      () => this.client.getPendingInteractions.query({ cloudAgentSessionId }),
      { cloudAgentSessionId }
    );
  }

  /** Ask the Worker to build an environment snapshot at the expected revision. */
  async buildEnvironment(
    input: EnvironmentBuildRequestInput
  ): Promise<EnvironmentBuildRequestResult> {
    return environmentBuildRequestResultSchema.parse(
      await this.client.buildEnvironment.mutate(input)
    );
  }

  async getEnvironmentBuildStatus(input: EnvironmentBuildScope): Promise<EnvironmentBuildStatus> {
    return environmentBuildStatusSchema.parse(
      await this.client.getEnvironmentBuildStatus.query(input)
    );
  }

  async getEnvironmentBuildLogs(input: EnvironmentBuildLogsInput): Promise<EnvironmentBuildLogs> {
    return environmentBuildLogsSchema.parse(await this.client.getEnvironmentBuildLogs.query(input));
  }

  async cancelEnvironmentBuild(
    input: EnvironmentBuildCancelInput
  ): Promise<EnvironmentBuildCancelResult> {
    return environmentBuildCancelResultSchema.parse(
      await this.client.cancelEnvironmentBuild.mutate(input)
    );
  }

  /** Prompt the coordinator to drop a deleted environment's build state. */
  async notifyEnvironmentDeleted(input: { environmentId: string }): Promise<void> {
    await this.client.notifyEnvironmentDeleted.mutate(input);
  }
}

/**
 * Create a cloud agent next client instance with the provided auth token
 */
export function createCloudAgentNextClient(
  authToken: string,
  options?: CloudAgentNextClientOptions
): CloudAgentNextClient {
  return new CloudAgentNextClient(authToken, options);
}

/**
 * Create a client that skips the worker balance check, used for free/BYOK models.
 */
export function createSkippedBalanceCheckCloudAgentNextClient(
  authToken: string
): CloudAgentNextClient {
  return new CloudAgentNextClient(authToken, {
    skipBalanceCheck: true,
  });
}

/**
 * Pick a Cloud Agent Next client for a session start based on whether the
 * chosen model is free or BYOK-billable for the caller.
 *
 * Free models (and BYOK-capable models, where the user provides their own key
 * and the model is therefore not billed against their balance) cost the user
 * nothing, so we set `x-skip-balance-check: true` to
 * allow $0-balance users to still create sessions when their selected model
 * is free. Paid models stay on the default client so the worker balance
 * middleware can still enforce the $1 minimum on paid-model sessions.
 *
 * The decision is made from caller-supplied booleans rather than re-querying
 * model metadata, so the helper can be unit-tested without a database and
 * matches the values the NewSessionPanel model picker already filters on.
 */
export function createCloudAgentNextClientForModel(
  authToken: string,
  model: { isFree: boolean; hasUserByokAvailable: boolean }
): CloudAgentNextClient {
  if (model.isFree || model.hasUserByokAvailable) {
    return createSkippedBalanceCheckCloudAgentNextClient(authToken);
  }
  return createCloudAgentNextClient(authToken);
}
