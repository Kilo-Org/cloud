import {
  parseRuntimeHarness,
  RUNTIME_HARNESS_HEADER,
  RUNTIME_HARNESSES,
  type RuntimeHarness,
  WORKSPACE_CONFIGURATION_HEADER,
  WORKSPACE_CONFIGURATION_VERSION,
  WORKTREE_RUNTIME_HEADER,
  WORKTREE_RUNTIME_VERSION,
} from '../../shared/control-plane-runtime-contract.js';
import {
  acceptRuntimeContract,
  canShareLegacyRepositoryCredentials,
  readRuntimeContract,
  resetRuntimeContract,
  runtimeSpecForContract,
} from './runtime-contract.js';
import { DurableObject } from 'cloudflare:workers';
import { admitVercelScmForward } from '../../scm-broker/vercel-admission.js';
import { admitScmRequest } from '../../scm-broker/admission.js';
import {
  verifiedVercelSandboxIdentityContract,
  VercelScmContainmentError,
} from '../../scm-broker/vercel-identity.js';
import type {
  ControlPlaneScmForwardAdmission,
  ControlPlaneScmForwardAdmissionResult,
} from '../../shared/control-plane-protocol.js';
import { z } from 'zod';
import {
  readWorkspaceSnapshot,
  readWorkspaceSnapshotAllocation,
  readWorkspaceSnapshotRaw,
  sameWorkspaceSnapshotIdentity,
  workspaceSnapshotIdentity,
  workspaceSnapshotIdentitySchema,
  workspaceSnapshotStatus,
  type WorkspaceSnapshotIdentity,
  workspaceSnapshotsEnabled,
  selectWorkspaceSnapshotResult,
  snapshotRestorePending,
  workspaceSnapshotFrame,
  captureIdleWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_IDLE_MS,
  writeWorkspaceSnapshotAllocation,
  clearWorkspaceSnapshotAllocation,
  deleteWorkspaceSnapshot,
  fenceWorkspaceSnapshot,
  workspaceSnapshotIdleAt,
  workspaceSnapshotOwner,
  workspaceSnapshotRestoreSkip,
  workspaceSnapshotRoutesEligible,
  liveWorkspaceRoutes,
  type WorkspaceSnapshotSelectionReason,
} from './workspace-snapshot.js';
import { commandFailureNote, promptWithCommandFailureNote } from './command-failure-note.js';
import { DEFAULT_DO_RETRY_CONFIG, withTimeout } from '@kilocode/worker-utils';
import { egressPolicySchema, type EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import { CloudAgentRunContainerSchema } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import {
  parseSandboxBillingInput,
  SANDBOX_USAGE_SKUS,
  type SandboxBillingInput,
} from '../../container-usage-context.js';
import { resolveSecret } from '../../auth.js';
import {
  workspaceMcpAnchorSessionId,
  type WorkspaceMcpBinding,
} from '../../cloud-agent-authority.js';
import {
  assertContainerCapacity,
  getContainerCapacityFailureReason,
} from '../../container-concurrency.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  mintSandboxLaunchCredential,
  parseSandboxLaunchBearer,
  sandboxCredentialMatchesHash,
  verifySandboxLaunchCredential,
} from '../../sandbox-control/credential.js';
import { rejectSandboxWrapperUpgrade } from '../../sandbox-control/socket-admission.js';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { createCloudflareContainersProviderAdapter } from '../../sandbox-control/cloudflare-containers-provider.js';
import {
  createRetiredCloudflareProviderAdapter,
  RetiredSandboxProviderError,
} from '../../sandbox-control/retired-cloudflare-provider.js';
import {
  sandboxProviderConfigurationSchema,
  ProviderCreationError,
  type ProviderAdapter,
  type ProviderAllocationIntent,
  type ProviderCreateIntent,
  type ProviderLaunchOptions,
  type ProviderLaunchResult,
  type ProviderStartSource,
  type ProviderStartupCommand,
  type SandboxProviderConfiguration,
} from '../../sandbox-control/provider.js';
import {
  vercelProviderLocatorSchema,
  type VercelProviderLocator,
} from '../../sandbox-control/vercel-provider.js';
import { buildControlWrapperLaunchEnv } from '../../sandbox-control/wrapper-launch-env.js';
import { downloadedStartup } from '../../sandbox-control/downloaded-startup.js';
import {
  newSandboxHarness,
  selectStartup,
  type StartupCohortContext,
} from '../../sandbox-control/startup-selection.js';
import {
  STARTUP_FAILURES,
  type StartupFailureCode,
} from '../../sandbox-control/startup-failure.js';
import { preinstalledStartup } from '../../sandbox-control/preinstalled-startup.js';
import type { GrantDiagnostic } from '../../sandbox-control/grant-diagnostic.js';
import {
  hasRuntimeCredentialProxy,
  prepareCredentialGrant,
  resolveSessionCredential,
  sessionCredentialsPayloadFromGrant,
  type SessionCredentialGrant,
} from '../../sandbox-control/session-credentials.js';
import { providerUsesOutboundCredentialProxy } from '../../agent-sandbox/capabilities.js';
import { getManagedOutboundContainerId } from '../../sandbox-id.js';
import {
  resolveSandboxIdClass,
  sandboxKindMatchesKey,
  type SandboxKind,
} from '../../sandbox-placement.js';
import { sessionDoName } from '../../session-identity.js';
import { logger } from '../../logger.js';
import {
  diagnosticCause,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from '../../sandbox-control/diagnostics.js';
import {
  getWorktreeCredentialContainment,
  type CredentialContainmentRequirements,
} from '../../sandbox-control/credential-containment.js';
import {
  runtimeProxyHandleGrantId,
  sameRuntimeProxyControlBinding,
  verifyRuntimeCredentialProxyHandle,
  verifyRuntimeCredentialProxyHandleExpiresAt,
} from '../../runtime-credential-proxy.js';
import {
  ACCEPTED_HANDLES_MAX,
  acceptedHandleIssuerLocator,
  addAcceptedHandleSync,
  constantTimeEqual,
  digestRuntimeProxyHandle,
  hasAcceptedScopeHandle,
  listAcceptedHandleStringsByScopeId,
  listAcceptedHandlesForScope,
  listAcceptedHandlesForScopeIncludingExpired,
  lookupAcceptedHandle,
  retireAcceptedHandlesSync,
  type ScopeBackingToken,
  type ScopeHandleResolution,
} from './accepted-handles.js';
import { markLastSentHandle, readLastSentHandleDigest } from './scope-handle-delivery.js';
import {
  memberHandleForSession,
  selectHandoffCandidate,
  setAllMemberHandles,
  sharedCanonicalHandleSurvivesRelease,
  type HandoffMemberState,
} from './scope-handle-rotation.js';
import { isActiveScopeMember } from './scope-view.js';
import {
  canonicalMintKey,
  CanonicalHandleMinter,
  clearRuntimeProxyMembers,
  decideCanonicalHandle,
  isAdoptableWorktreeScope,
  isWorkspaceProxyScope,
  MAX_SCOPE_MEMBERS,
  MixedCredentialClassError,
  ScopeHandleConflictError,
  ScopeMemberLimitError,
  scopeMemberCount,
  withMemberHandle,
  type CanonicalHandleMint,
} from './scope-handle-adoption.js';
import {
  decideRenewedScopeCandidate,
  expectedScopeForCandidate,
  scopeBackingMatchesGrant,
  selectScopeHandleCandidates,
} from './scope-handle-resolution.js';
import { buildScopeGrantView, type ScopeGrantView } from './scope-view.js';
import { readScopeGrantView } from './scope-view-store.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  worktreeDeleteResultSchema,
  worktreePrepareDeletionResultSchema,
  type SessionAttachPayload,
} from '../../shared/sandbox-control-protocol.js';
import { MCPServerConfigSchema } from '../../persistence/schemas.js';
import {
  McpAttachValidationError,
  McpConfigurationError,
  mcpConfigurationFailureReason,
  mcpValidationMessage,
  materializeMcpServers,
  parseSessionAttachMcpServers,
  type CliMcpServer,
} from '../../mcp-config.js';
import {
  attachmentSpecFromRouteSpec,
  workspaceConfigFromSpec,
} from '../../shared/workspace-config.js';
import {
  PreviewServicesScanSchema,
  type ListPreviewServicesOutput,
} from '../../shared/preview-services.js';
import {
  CONTROL_PLANE_ALLOCATION_ID_ENV,
  CONTROL_PLANE_PROTOCOL_VERSION,
  CONTROL_PLANE_REQUEST_TIMEOUT_MS,
  CONTROL_PLANE_WORKTREE_GIT_TIMEOUT_MS,
  controlPlaneAnswerPayloadSchema,
  controlPlaneDeliverPayloadSchema,
  controlPlaneKiloRequestInputSchema,
  controlPlanePrepareInputSchema,
  controlPlaneRouteSpecSchema,
  controlPlaneSessionCredentialsPayloadSchema,
  controlPlaneSessionRefPayloadSchema,
  controlPlaneTerminalInputSchema,
  controlPlaneWorktreeCaptureInputSchema,
  controlPlaneWorktreeDeletionPayloadSchema,
  controlPlaneWrapperFrameSchema,
  type AttachmentSpec,
  type ControlPlaneAnswerPayload,
  type ControlPlaneCommandFailure,
  type ControlPlaneControlResult,
  type ControlPlaneCredentialSource,
  type ControlPlaneDeliverPayload,
  type ControlPlaneDeliverResult,
  type ControlPlaneDispatchResult,
  type ControlPlaneEventsNotification,
  type ControlPlaneFailureReason,
  type ControlPlaneKiloRequestInput,
  type ControlPlaneOutcome,
  type ControlPlaneRequestError,
  type ControlPlaneRouteSpec,
  type ControlPlaneRouteUpdate,
  type ControlPlaneRouteView,
  type ControlPlaneSessionCredentialsPayload,
  type ControlPlaneSessionRefPayload,
  type ControlPlaneStatusResult,
  type ControlPlaneTerminalInput,
  type ControlPlaneWorktreeCaptureInput,
  type ControlPlaneWrapperFrame,
  type ControlPlaneWorkspaceFailureSubtype,
  type WorkspaceConfig,
} from '../../shared/control-plane-protocol.js';
import {
  controlPlaneWorktreeGitInputSchema,
  type ControlPlaneWorktreeGitInput,
} from '../../shared/worktree-git-operations.js';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
  sandboxIdlePolicyForOrigins,
} from '../../shared/control-plane-timers.js';
import {
  controlPlaneSandboxSelectionSchema,
  type ControlPlanePrepareInputWithSelection,
  type ControlPlaneSandboxSelection,
} from '../session/sandbox-selection.js';
import { withDORetry } from '../../utils/do-retry.js';
import { agentSandboxProviderSchema, type AgentSandboxProvider, type Env } from '../../types.js';
import { sandboxSessionPeerNamespace } from '../peer-bindings.js';
import migrations from './drizzle/migrations';
import {
  connectionMatches,
  initialAllocationState,
  nextAllocationAlarmAt,
  reduceAllocation,
  type AllocationEffect,
  type AllocationEvent,
  type AllocationState,
  type AllocationView,
  type SandboxTimers,
} from './allocation.js';
import {
  deleteRoute,
  dropReadyRoutes,
  earliestRouteDeadlineAt,
  ensureRoute,
  failRoute,
  failCurrentAttempt,
  failExpiredRoutes,
  failReadyRoutesForScope,
  grantIssueFailure,
  isCurrentPreparingAttempt,
  listRoutes,
  notifyPreparingRoutes,
  notifyReadyRoutes,
  onRouteFailed,
  onRouteProgress,
  onRouteReady,
  onWrapperConnected,
  readRoute,
  routeRetryAllowed,
  routeView,
  writeRoute,
  type RouteContext,
  type RouteGrantIssue,
  type RoutePreparationProgress,
  type RouteRecord,
} from './routes.js';
import { allocation as allocationTable, routes as routesTable } from './sqlite-schema.js';
import {
  credentialRenewalDueAt,
  nextCredentialRenewalAt,
  pruneCredentialRenewalRetries,
  type CredentialRenewalRetries,
} from './credential-renewal.js';
import {
  listScopeGrants,
  readScopeGrant,
  retireScopeGrants,
  scopeGrantId,
  writeScopeGrant,
} from './scope-grants.js';
import { buildFrameEnv } from './frame-env.js';
import {
  beginRepositoryLaunch,
  confirmRepositoryLaunch,
  readRepositoryLaunch,
  recordRepositoryLaunch,
} from './repository-launch.js';
import {
  environmentLaunchCandidate,
  environmentSnapshotDecision,
  environmentSnapshotStartBlock,
  environmentStartDetail,
  lookupEnvironmentSnapshot,
  type EnvironmentLaunchCandidate,
  type EnvironmentLookup,
  type EnvironmentSnapshotBlock,
} from './environment-snapshot-launch.js';
import {
  snapshotStartFailureIsPermanent,
  type SnapshotStartFailureReason,
} from '../../sandbox-containers/snapshot-start-failures.js';
import {
  environmentReferenceSchema,
  type SessionEnvironmentReference,
} from '../../environment-build/reference.js';
import {
  beginWorktreeDeletion,
  controlPlaneWorktreeDeletionInputSchema,
  finishWorktreeDeletion,
  loadWorktreeDeletionJournal,
  persistWorktreeDeletionManifest,
  WORKTREE_DELETION_PREFIX,
  WorktreeDeletionIncompleteError,
  worktreeOwnedRoutes,
  type ControlPlaneWorktreeDeletionInput,
  type WorktreeDeletionPlan,
} from './worktree-deletion.js';
import { projectAllocationStatusSnapshot } from './status-snapshot.js';
import {
  readObservedRuntimeVersions,
  readRuntimeIdentity,
  resetRuntimeIdentity,
  writeRuntimeIdentity,
} from './runtime-identity.js';
import { createSandboxNotificationDispatcher, type SandboxNotification } from './notifications.js';
import { resolvePreviewTarget, type PreviewTargetResult } from './preview-target.js';
import {
  SandboxRuntimeVersionSchema,
  type SandboxStatusSnapshot,
} from '../../shared/sandbox-status.js';
import type { WorkspaceBillingProjection } from '../../shared/workspace-runtime-status.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import {
  createSharedWorktreeChanges,
  worktreeSubscriberKey,
  type SharedWorktreeChangesInput,
} from './worktree-changes.js';
import { serveHistoryPage, type HistoryPageSession } from './history-pages.js';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { WorktreeRecovery } from '../../shared/worktree-changes-wire.js';
import type { WorktreeChangesReady } from '../worktree-changes-ready.js';
import type { WorktreeChangesContext } from '../../sandbox-session/worktree-changes.js';
import { buildNativeEgressAllowlist } from '../../sandbox-control/egress-policy.js';
import { nativeEgressAllowlistSchema } from '../../sandbox-containers/egress-policy.js';
import {
  createByocVercelProviderAdapter,
  unavailableVercelProviderAdapter,
  ByocVercelProviderError,
  type ByocVercelSource,
} from '../../byoc/vercel-provider.js';
import {
  SNAPSHOT_VALIDATOR_REF_KEY,
  snapshotValidatorAllocation,
  snapshotValidatorInputSchema,
  type SnapshotValidatorInput,
} from './snapshot-validator.js';

const GENERATION_KEY = 'control_plane_generation';
const GENERATION = 2;
const CREDENTIAL_HASH_KEY = 'wrapper_credential_hash';
const RUNTIME_HARNESS_KEY = 'runtime_harness';
const OWNER_KEY = 'control_plane_owner';
const COMMAND_FAILURE_NOTE_KEY_PREFIX = 'command_failure_note:';

type PendingCommandFailureNote = { attemptId: string; note: string };

const ALLOCATION_ROW_ID = 'current';

export type StoredProviderPin = {
  byoc?: ByocVercelSource;
  provider: AgentSandboxProvider;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  locator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
  containment: CredentialContainmentRequirements | null;
  /** Stored kind of a placed key. Legacy prefixed keys have none. */
  sandboxKind?: SandboxKind;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

export type EnsureAllocationInput = {
  byoc?: ByocVercelSource;
  provider?: AgentSandboxProvider;
  allocationName?: string;
  configuration?: SandboxProviderConfiguration;
  locator?: VercelProviderLocator;
  billing?: SandboxBillingInput;
  containment?: CredentialContainmentRequirements;
  sandboxKind?: SandboxKind;
  egressMode?: EgressMode;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

const wrapperSocketAttachmentSchema = z.object({
  credential: z.string().nullable(),
  helloDeadlineAt: z.number().finite().nonnegative().optional(),
  allocationId: z.string().optional(),
  connectionId: z.string().optional(),
  wrapperId: z.string().optional(),
  heartbeatAck: z.literal(true).optional(),
  workspaceSnapshots: z.literal(true).optional(),
  redactsNamedSecrets: z.literal(true).optional(),
  installsSkillsSh: z.literal(true).optional(),
  worktreeGit: z.literal(true).optional(),
  workspaceConfiguration: z.literal(true).optional(),
  runtimeCapability: z.literal('worktree').optional(),
  runtimeHarness: z.enum(RUNTIME_HARNESSES).optional(),
  kiloCliVersion: SandboxRuntimeVersionSchema.optional(),
  wrapperVersion: SandboxRuntimeVersionSchema.optional(),
  billingCheckedAt: z.number().finite().nonnegative().optional(),
});
type WrapperSocketAttachment = z.infer<typeof wrapperSocketAttachmentSchema>;

const WRAPPER_BILLING_CHECK_MS = 30_000;

function runtimeHarnessField(runtimeHarness: RuntimeHarness | undefined) {
  return runtimeHarness === undefined ? {} : { runtimeHarness };
}

/** Separates an old wrapper from a decrypt/parse failure; both fail the attempt. */
type PrepareFrameMaterializationStage =
  | 'wrapper_redaction_unsupported'
  | 'wrapper_skills_sh_unsupported'
  | 'frame_materialization_failed';

class PrepareFrameMaterializationError extends Error {
  constructor(
    readonly stage: PrepareFrameMaterializationStage,
    readonly sourceErrorName?: string
  ) {
    super('session.prepare frame materialization failed');
    this.name = 'PrepareFrameMaterializationError';
  }
}

type MaterializedPrepareFrame =
  | { type: 'session.prepare'; spec: ControlPlaneRouteSpec }
  | { type: 'session.attach'; spec: AttachmentSpec; workspace: WorkspaceConfig };

/** A workspace tail descriptor exists but cannot be used. The descriptor is retained. */
type WorkspaceSnapshotFailureReason =
  | Exclude<WorkspaceSnapshotSelectionReason, 'missing' | 'selected'>
  | 'unsupported';

class WorkspaceSnapshotLaunchError extends Error {
  constructor(
    readonly reason: WorkspaceSnapshotFailureReason,
    readonly detail: string
  ) {
    super('Workspace snapshot cannot start');
    this.name = 'WorkspaceSnapshotLaunchError';
  }
}

/** A required environment snapshot is missing, building, failed or unsupported. */
class EnvironmentSnapshotRequiredError extends Error {
  constructor(readonly block: EnvironmentSnapshotBlock) {
    super('Environment snapshot required');
    this.name = 'EnvironmentSnapshotRequiredError';
  }
}

type EnvironmentSnapshotUnusableReason = 'provider_no_snapshots' | 'not_isolated';

const ENVIRONMENT_SNAPSHOT_UNUSABLE_DETAIL: Record<EnvironmentSnapshotUnusableReason, string> = {
  provider_no_snapshots:
    'This sandbox provider does not support environment snapshots yet, so it cannot start an environment with build commands.',
  not_isolated:
    'This session uses a retired sandbox type that cannot use an environment with build commands. Start a new session.',
};

/**
 * No environment snapshot can ever serve this start, so a rebuild cannot help.
 * The start fails at the sandbox step, not the environment snapshot step, so
 * clients do not offer the environment build.
 */
class EnvironmentSnapshotUnusableError extends Error {
  constructor(
    readonly reason: EnvironmentSnapshotUnusableReason,
    readonly detail: string,
    readonly environmentId: string
  ) {
    super('Environment snapshot unusable');
    this.name = 'EnvironmentSnapshotUnusableError';
  }
}

/** A provider snapshot start failed; permanent reasons are not retried. */
class SnapshotStartFailureError extends Error {
  constructor(
    readonly source: 'workspace' | 'environment',
    readonly reason: SnapshotStartFailureReason,
    readonly detail: string,
    readonly environmentBlock?: EnvironmentSnapshotBlock
  ) {
    super('Snapshot start failed');
    this.name = 'SnapshotStartFailureError';
  }
}

type SnapshotStartSelection =
  | { source: 'workspace'; capturedAt: number }
  | {
      source: 'environment';
      candidate: EnvironmentLaunchCandidate;
      buildId: string | null;
    };

function environmentBuildIdOfLookup(lookup: EnvironmentLookup): string | null {
  if (lookup.kind !== 'resolved') return null;
  const admission = lookup.resolution.admission;
  if (admission.status === 'admitted' || admission.status === 'active') return admission.buildId;
  return lookup.resolution.build?.buildId ?? null;
}

function workspaceSnapshotFailureDetail(
  reason: WorkspaceSnapshotFailureReason,
  capturedAt?: number
): string {
  const since =
    capturedAt === undefined
      ? 'Start fresh to discard this workspace snapshot.'
      : `Start fresh discards changes since ${new Date(capturedAt).toISOString()}.`;
  switch (reason) {
    case 'expired':
      return `The workspace snapshot expired. ${since}`;
    case 'invalid_descriptor':
      return `The workspace snapshot metadata is invalid. ${since}`;
    case 'ownership_mismatch':
      return `The workspace snapshot belongs to another workspace. ${since}`;
    case 'runtime_mismatch':
      return `The workspace snapshot was captured with a different runtime. ${since}`;
    case 'image_mismatch':
      return `The workspace snapshot was captured from a different sandbox image. ${since}`;
    case 'image_unavailable':
      return `The sandbox image for the workspace snapshot could not be resolved. Send a message to retry. ${since}`;
    case 'unsupported':
      return `This sandbox provider cannot restore the workspace snapshot. ${since}`;
  }
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function materializationStage(error: unknown): PrepareFrameMaterializationStage {
  if (error instanceof PrepareFrameMaterializationError) return error.stage;
  return 'frame_materialization_failed';
}

/**
 * The Sandbox DO -> Session DO notification surface (spec §10). The V2 Session
 * DO is B4, so the production factory resolves a stub only when the test-only
 * binding exists; tests inject a fake peer instead.
 */
export type ControlPlaneSessionPeer = HistoryPageSession & {
  issueCloudAgentMcpGrant?(
    workspace?: WorkspaceMcpBinding
  ): Promise<{ url: string; token: string; expiresAt: number } | undefined>;
  onRoute(update: ControlPlaneRouteUpdate): Promise<void>;
  onEvents(notification: ControlPlaneEventsNotification): Promise<void>;
  onOutcome(outcome: ControlPlaneOutcome): Promise<void>;
  /** False when the session no longer reads the worktree, so it is not notified again. */
  onWorktreeChangesReady(notification: WorktreeChangesReady): Promise<boolean>;
  /**
   * R1: the Session DO owns the grant and mints the runtime credential proxy
   * handle. The Sandbox DO passes its own allocation fence so the Session DO
   * never calls back into this DO's queue.
   */
  issueRuntimeCredentialProxyGrant(
    fence: ControlRuntimeCredentialProxyFence
  ): Promise<string | null>;
  /**
   * Renews this member's own backing token without matching the caller's handle
   * against its stored grant; the Sandbox DO has already authorized the scope.
   * The member self-validates the expected scope and returns null on mismatch.
   */
  issueRuntimeProxyBackingToken(input: {
    sandboxId: string;
    directory: string;
    kiloSessionId: string;
  }): Promise<ScopeBackingToken | null>;
  /**
   * The member's live delegation expiry in milliseconds, or null when this
   * Session DO cannot serve the scope. Used to pick a proactive handoff issuer
   * whose delegation outlives the canonical handle; only reads durable state, it
   * does not renew or mint.
   */
  getRuntimeProxyDelegationExpiresAt(input: {
    sandboxId: string;
    directory: string;
    kiloSessionId: string;
  }): Promise<number | null>;
};

/** Spec §10: the runtime credential proxy fence returned to the Worker. */
export type ControlRuntimeCredentialProxyFence = {
  plane: 'control';
  allocationId: string;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

/** The fence plus, for an adopted handle, the current scope view or the reason it is unavailable. */
export type ControlRuntimeCredentialProxyFenceScope = ControlRuntimeCredentialProxyFence & {
  scopeView?: ScopeGrantView;
  scopeViewUnavailable?: string;
};

/** The adopted-handle state a scope is already serving, if any. */
type CanonicalHandleState = CanonicalHandleMint & {
  /** The requesting member can be served this handle, by holding or by binding it. */
  usable: boolean;
};

/** The serialized outcome of claiming a canonical handle for a preparing route. */
type ScopeHandleClaim =
  | { kind: 'handle'; handle: string }
  | { kind: 'stale' }
  | { kind: 'remint' }
  | { kind: 'per-session' }
  | { kind: 'fail' };

type LegacyCutover = {
  provider: AgentSandboxProvider;
  providerRef: string | null;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  vercelLocator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Frames from the old (protocol version 1) wrapper use `request`/`event`
 * envelopes. V2 has no backward compatibility, so the socket is closed.
 */
function isLegacyWrapperFrame(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'request' || value.type === 'response' || value.type === 'event';
}

type AllocationRow = typeof allocationTable.$inferSelect;

function stateToRow(state: AllocationState): typeof allocationTable.$inferInsert {
  return {
    id: ALLOCATION_ROW_ID,
    state: state.kind,
    allocation_id: state.allocationId,
    connection_id: state.connectionId,
    provider_ref: state.providerRef,
    wrapper_id: state.wrapperId,
    last_frame_at: state.lastFrameAt,
    last_activity_at: state.lastActivityAt,
    create_deadline_at: state.createDeadlineAt,
    first_connect_deadline_at: state.firstConnectDeadlineAt,
    create_attempt: state.createAttempt,
    stop_attempt: state.stopAttempt,
    stop_pending: state.stopPending,
    stop_at: state.stopAt,
    unconfirmed_provider_ref: state.unconfirmedProviderRef,
  };
}

function rowToState(row: AllocationRow): AllocationState {
  return {
    kind: row.state,
    allocationId: row.allocation_id,
    connectionId: row.connection_id,
    providerRef: row.provider_ref,
    wrapperId: row.wrapper_id,
    lastFrameAt: row.last_frame_at,
    lastActivityAt: row.last_activity_at,
    createDeadlineAt: row.create_deadline_at,
    firstConnectDeadlineAt: row.first_connect_deadline_at,
    createAttempt: row.create_attempt,
    stopAttempt: row.stop_attempt,
    stopPending: row.stop_pending,
    stopAt: row.stop_at,
    unconfirmedProviderRef: row.unconfirmed_provider_ref,
  };
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/**
 * The preparation step the allocation owns until the wrapper connects. Once a
 * wrapper is bound it reports its own steps, so there is none here.
 */
function sandboxPreparationProgress(state: AllocationState): RoutePreparationProgress | undefined {
  switch (state.kind) {
    case 'stopped':
    case 'creating':
      return { step: 'sandbox_create' };
    case 'stopping':
      return { step: 'sandbox_create', detail: 'Waiting for the previous sandbox to stop' };
    case 'starting':
      return { step: 'sandbox_start' };
    case 'connected':
    case 'disconnected':
      return undefined;
  }
}

/** Upper bound on concurrently outstanding wrapper control requests. */
const MAX_PENDING_CONTROL_REQUESTS = 64;

/** Wrapper scan bound plus headroom, below the generic control request budget. */
const PREVIEW_SERVICES_CONTROL_TIMEOUT_MS = 6_000;

const WRAPPER_NOT_CONNECTED = 'Wrapper is not connected';
const WRAPPER_WRITE_FAILED = 'Wrapper socket write failed';
const WRAPPER_REQUEST_TIMED_OUT = 'Wrapper request timed out';
const PRE_SEND_NOT_READY_MESSAGES = new Set([WRAPPER_NOT_CONNECTED, WRAPPER_WRITE_FAILED]);

/**
 * Result of the queued half of a control request: either an early failure, or
 * the wrapper-reply promise the caller awaits outside the queue.
 */
type ControlRequestHandoff =
  | { promise: Promise<ControlPlaneControlResult> }
  | { error: ControlPlaneControlResult };

function controlRequestFailure(
  code: string,
  message: string,
  retryable: boolean
): ControlPlaneControlResult {
  return { ok: false, error: { code, message, retryable } };
}

/**
 * The wrapper result frames that answer a correlated control request. Kept as
 * one list so a new request kind cannot be registered without its reply being
 * resolvable (spec §10).
 */
const CORRELATED_RESULT_FRAME_TYPES = new Set<string>([
  'worktree.result',
  'terminal.result',
  'kilo.result',
  'preview.result',
]);

type CorrelatedResultFrame = Extract<
  ControlPlaneWrapperFrame,
  { type: 'worktree.result' | 'terminal.result' | 'kilo.result' | 'preview.result' }
>;

function isCorrelatedResultFrame(frame: unknown): frame is CorrelatedResultFrame {
  if (!isRecord(frame)) return false;
  return typeof frame.type === 'string' && CORRELATED_RESULT_FRAME_TYPES.has(frame.type);
}

/** Maps one terminal request to its wrapper frame, preserving the operation. */
function terminalRequestFrame(
  requestId: string,
  input: ControlPlaneTerminalInput
): Extract<
  ControlPlaneWrapperFrame,
  { type: 'terminal.create' | 'terminal.resize' | 'terminal.close' | 'terminal.connect' }
> {
  switch (input.operation) {
    case 'create':
      return {
        type: 'terminal.create',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'resize':
      return {
        type: 'terminal.resize',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'close':
      return {
        type: 'terminal.close',
        requestId,
        session: input.session,
        payload: input.payload,
      };
    case 'connect':
      return {
        type: 'terminal.connect',
        requestId,
        session: input.session,
        payload: input.payload,
      };
  }
}

export class SandboxControlV2 extends DurableObject<Env> {
  readonly sandboxId: string;
  private readonly db: ReturnType<typeof drizzle>;
  private readonly initialized: Promise<void>;
  private readonly operations: { tail: Promise<unknown> } = { tail: Promise.resolve() };
  private provider: ProviderAdapter;
  private providerPin: StoredProviderPin | null = null;
  private createInFlight = false;
  /**
   * The allocation whose provider launch has not returned yet. A wrapper may
   * connect before the launch reports how the container started; it receives
   * no preparation until then, so a requested snapshot that did not start is
   * never prepared as a fresh workspace.
   */
  private launchInFlightAllocationId: string | null = null;
  private readonly worktreeChanges = createSharedWorktreeChanges({
    storage: this.ctx.storage,
    capture: input => this.worktreeCapture(input),
    onSnapshot: (context, revision) =>
      this.ctx.waitUntil(this.notifyWorktreeChangesReady(context, revision)),
  });
  /**
   * Single-flight canonical handle mints, keyed by scope and current fence. Two
   * concurrent preparers of the same scope wait on one Session DO mint so only
   * the winner issues a handle; the loser adopts the winner's string.
   */
  private readonly canonicalHandleMints = new CanonicalHandleMinter<
    ControlPlaneSessionPeer,
    ControlRuntimeCredentialProxyFence
  >(
    (peer, fence) => this.mintRuntimeProxyGrant(peer, fence),
    handle => this.runtimeProxyHandleClaims(handle)
  );
  /**
   * Outstanding worktree-change requests forwarded to the wrapper, keyed by
   * request id (spec §10). The wrapper answers with one result frame; the reply
   * is resolved on the socket message path, not the serial queue, so a queued
   * request can await it without blocking the queue. The socket is kept so a
   * close can fail every request it owned at once.
   */
  private readonly pendingControlRequests = new Map<
    string,
    {
      socket: WebSocket;
      resolve: (result: ControlPlaneControlResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Bound on one wrapper reply; overridable in tests to exercise the timeout. */
  controlRequestTimeoutMs = CONTROL_PLANE_REQUEST_TIMEOUT_MS;
  workspaceSnapshotIdleMs = WORKSPACE_SNAPSHOT_IDLE_MS;
  private workspaceSnapshotCapturePending = false;
  /** Earliest retry per grant scope after a failed renewal; in memory, so eviction retries once. */
  private readonly credentialRenewalRetryAt: CredentialRenewalRetries = new Map();
  /**
   * Notification factory for the V2 Session DO. The default resolves the
   * `ownerId:sessionId` name through the shared binding accessor; tests inject a
   * fake.
   */
  sessionPeerFor: (ownerId: string, sessionId: string) => ControlPlaneSessionPeer | null = (
    ownerId,
    sessionId
  ) => this.resolveSessionPeer(ownerId, sessionId);

  private readonly notifications = createSandboxNotificationDispatcher({
    budgetMs: () => CONTROL_PLANE_TIMERS.sandbox.sessionNotifyDeadlineMs,
    send: (sessionId, notification, deadlineAt, signal) =>
      this.notifySession(sessionId, notification, deadlineAt, signal),
    waitUntil: work => this.ctx.waitUntil(work),
    diagnostic: loss =>
      logger.withFields({ sandboxId: this.sandboxId, ...loss }).warn('Sandbox notification loss'),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandboxId = ctx.id.name ?? ctx.id.toString();
    this.db = drizzle(ctx.storage, { logger: false });
    this.provider = this.createProviderAdapter(this.defaultPin('cloudflare-containers'));
    this.initialized = ctx.blockConcurrencyWhile(() => this.initializeStorage());
  }

  /**
   * Establishes the provider pin and starts the allocation. `prepare` starts an
   * allocation from the stored pin without going through here, so callers that
   * need a non-default provider must call this while stopped.
   */
  async ensureAllocation(input: EnsureAllocationInput = {}): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      if (state.kind === 'stopped') {
        const pin = this.pinFromInput(input);
        await this.writeProviderPin(pin);
        this.providerPin = pin;
        this.provider = this.createProviderAdapter(pin);
      }
      await this.applyEvent({
        type: 'ensure',
        at: Date.now(),
        allocationId: crypto.randomUUID(),
      });
    });
  }

  async initializeSnapshotValidator(input: SnapshotValidatorInput): Promise<void> {
    await this.initialized;
    const parsed = snapshotValidatorInputSchema.parse(input);
    await this.enqueue(async () => {
      const adopted = snapshotValidatorAllocation(this.sandboxId, parsed, Date.now());
      const registered = await this.ctx.storage.get<string>(SNAPSHOT_VALIDATOR_REF_KEY);
      const state = await this.readAllocation();
      if (registered !== undefined) {
        if (
          registered !== parsed.allocation.providerRef ||
          state.providerRef !== registered ||
          JSON.stringify(this.providerPin) !== JSON.stringify(adopted.pin)
        ) {
          throw new Error('Snapshot validator allocation changed');
        }
        if ((await this.ctx.storage.get(CREDENTIAL_HASH_KEY)) === parsed.credentialHash) return;
        if (this.ctx.getWebSockets().length > 0)
          throw new Error('Snapshot validator already connected');
        await this.ctx.storage.put(CREDENTIAL_HASH_KEY, parsed.credentialHash);
        return;
      }
      if (
        state.kind !== 'stopped' ||
        state.unconfirmedProviderRef !== null ||
        this.providerPin?.byoc !== undefined ||
        (await this.requireOwner()) !== null
      ) {
        throw new Error('Snapshot validator control is unavailable');
      }
      await this.ctx.storage.transaction(async () => {
        await this.writeProviderPin(adopted.pin);
        await this.writeAllocation(adopted.state);
        await this.ctx.storage.put({
          [SNAPSHOT_VALIDATOR_REF_KEY]: parsed.allocation.providerRef,
          [CREDENTIAL_HASH_KEY]: parsed.credentialHash,
        });
      });
      this.providerPin = adopted.pin;
      this.provider = this.createProviderAdapter(adopted.pin);
      await this.armAlarm(adopted.state);
    });
  }

  async getSnapshotValidatorStatus(): Promise<{ physical: string; connection: string }> {
    await this.initialized;
    if (!(await this.ctx.storage.get(SNAPSHOT_VALIDATOR_REF_KEY)))
      throw new Error('Snapshot validator is not registered');
    const state = await this.readAllocation();
    return {
      physical: state.kind === 'stopped' ? 'stopped' : 'running',
      connection: state.kind === 'connected' ? 'ready' : 'connecting',
    };
  }

  async confirmSnapshotValidatorStopped(providerRef: string): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      if (!/^ses-byoc-validator-[0-9a-f]{32}$/i.test(this.sandboxId))
        throw new Error('Snapshot validator identity mismatch');
      const registered = await this.ctx.storage.get<string>(SNAPSHOT_VALIDATOR_REF_KEY);
      const state = await this.readAllocation();
      if (registered === undefined && state.kind === 'stopped') return;
      if (registered !== providerRef) throw new Error('Snapshot validator allocation changed');
      await this.applyEvent({ type: 'provider-gone', at: Date.now() });
    });
  }

  /** B3/D3 reports the provider no longer has the sandbox (spec §6 "any → stopped"). */
  async reportProviderGone(): Promise<void> {
    await this.initialized;
    await this.enqueue(() => this.applyEvent({ type: 'provider-gone', at: Date.now() }));
  }

  /** Passive read for tests and B3's `status`/B10's badge. */
  async getAllocationState(): Promise<AllocationView> {
    await this.initialized;
    return {
      ...(await this.readAllocation()),
      provider: this.currentProvider(),
      configuration: this.providerPin?.configuration ?? null,
    };
  }

  /**
   * Worker-facing status RPC (spec §10, B10 badge). Projects the V2 allocation
   * state into the public snapshot; it never probes the provider or the wrapper.
   * No owner means no evidence, so the snapshot is `unknown`.
   */
  async getStatusSnapshot(
    identity: WorkspaceSnapshotIdentity | null = null
  ): Promise<SandboxStatusSnapshot> {
    await this.initialized;
    return this.enqueue(async () => {
      const owner = await this.requireOwner();
      const allocation = owner === null ? null : await this.getAllocationState();
      const parsedIdentity = workspaceSnapshotIdentitySchema.safeParse(identity);
      return {
        ...projectAllocationStatusSnapshot({
          allocation,
          observedAt: Date.now(),
          inactivityTimeoutMs: this.sandboxIdleTimeoutMs(allocation),
          runtimeIdentity: readRuntimeIdentity(
            this.ctx.storage.kv,
            allocation?.allocationId ?? null
          ),
        }),
        ...workspaceSnapshotStatus(
          this.db,
          parsedIdentity.success &&
            parsedIdentity.data.sandboxId === this.sandboxId &&
            parsedIdentity.data.userId === owner
            ? parsedIdentity.data
            : null
        ),
      };
    });
  }

  /**
   * Passive workspace billing projection (workspace status). Reads the stored
   * provider pin and the provider's read-only billing runtime status. It never
   * admits work, starts the container or opens a metered interval.
   */
  async getWorkspaceBillingProjection(): Promise<WorkspaceBillingProjection | null> {
    await this.initialized;
    return this.enqueue(async () => {
      const pin = this.providerPin;
      if (pin === null) return null;
      let projection: Awaited<ReturnType<NonNullable<ProviderAdapter['getBillingProjection']>>>;
      try {
        projection = await this.provider.getBillingProjection?.();
      } catch {
        projection = undefined;
      }
      const context = projection?.context;
      const enforcementRequested = pin.billing?.enforcementRequested === true;
      return {
        payer: context?.subject ?? pin.billing?.subject ?? null,
        actor: context?.actor ?? pin.billing?.actor ?? null,
        onBehalfOf: context?.onBehalfOf ?? pin.billing?.onBehalfOf ?? null,
        sku: projection === undefined ? null : SANDBOX_USAGE_SKUS[projection.sandboxClassName],
        blocked: projection?.blocked ?? (enforcementRequested ? null : false),
        enforcementRequested,
        intervalStartedAt: context?.startEpochMs ?? null,
        meterInstanceId: pin.billing?.sandboxId ?? null,
      };
    });
  }

  /**
   * The provider kind and allocation name the adapter is built from. Read from
   * the persisted pin, so after eviction it proves the rebuild used storage.
   */
  async getProviderRuntime(): Promise<{ provider: AgentSandboxProvider; allocationName: string }> {
    await this.initialized;
    return {
      provider: this.currentProvider(),
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
    };
  }

  /**
   * Session DO -> Sandbox DO (spec §10). Returns the route view at once and
   * never waits for a provider call. An absent or `failed` route starts a new
   * preparation attempt; any other repeated call keeps its attempt deadline.
   * The DO-only `credentials` snapshot mints the route grant; it never reaches
   * the wrapper.
   */
  async prepare(input: ControlPlanePrepareInputWithSelection): Promise<ControlPlaneRouteView> {
    await this.initialized;
    // The shared prepare schema stays authoritative: it carries the superRefine
    // that rejects `spec.git.token`/`spec.kilo` (B3 review 2, N3). The DO-only
    // selection is split off and validated separately first, because the shared
    // schema is strict and must not learn about the extra field.
    const sandboxSelection =
      input.sandboxSelection === undefined
        ? undefined
        : controlPlaneSandboxSelectionSchema.parse(input.sandboxSelection);
    const parsed = controlPlanePrepareInputSchema.parse({
      spec: input.spec,
      credentials: input.credentials,
    });
    const environment =
      input.environment === undefined
        ? undefined
        : environmentReferenceSchema.parse(input.environment);
    return this.enqueue(() =>
      this.runPrepare(parsed.spec, parsed.credentials, sandboxSelection, environment)
    );
  }

  async deliver(payload: ControlPlaneDeliverPayload): Promise<ControlPlaneDeliverResult> {
    await this.initialized;
    const parsed = controlPlaneDeliverPayloadSchema.parse(payload);
    return this.enqueue(() => this.runDeliver(parsed));
  }

  private workspaceSnapshotRouteEligible(route: RouteRecord): boolean {
    const result = (reason: string) => {
      logControlDiagnostic(
        'workspace_snapshot_eligibility',
        {
          sandboxId: this.sandboxId,
          workspaceId: route.credentialSource?.workspaceId,
          sessionId: route.sessionId,
          reason,
          configured: Boolean(
            this.env.WORKSPACE_SNAPSHOT_USER_IDS?.trim() ||
            this.env.WORKSPACE_SNAPSHOT_ORG_IDS?.trim()
          ),
        },
        'info',
        { coalesceIdentity: `workspace_snapshot_eligibility:${this.sandboxId}:${route.sessionId}` }
      );
      return reason === 'eligible';
    };
    if (this.currentProvider() !== 'cloudflare-containers') return result('unsupported_provider');
    if (route.credentialSource === null) return result('missing_credentials');
    if (!workspaceSnapshotsEnabled(this.env, route.credentialSource))
      return result('not_allowlisted');
    if (sandboxIdlePolicyForOrigins([route.credentialSource.createdOnPlatform]) !== 'interactive')
      return result('non_interactive');
    if (route.credentialSource.workspaceId === undefined) return result('unregistered_workspace');
    if (
      workspaceSnapshotIdentity(this.sandboxId, route.spec.directory, route.credentialSource) ===
      null
    )
      return result('scope_mismatch');
    try {
      const kind = resolveSandboxIdClass({
        sandboxId: this.sandboxId,
        sandboxKind: this.providerPin?.sandboxKind,
      });
      return result(
        kind === 'isolated-small' || kind === 'isolated-standard' ? 'eligible' : 'unsupported_class'
      );
    } catch {
      return result('invalid_class');
    }
  }

  private async captureIdleWorkspaceSnapshot(): Promise<void> {
    const provider = this.provider.workspaceSnapshots;
    if (provider === undefined || this.workspaceSnapshotCapturePending) return;
    this.workspaceSnapshotCapturePending = true;
    try {
      await captureIdleWorkspaceSnapshot({
        db: this.db,
        sandboxId: this.sandboxId,
        provider,
        idleMs: this.workspaceSnapshotIdleMs,
        enqueue: operation =>
          this.enqueue(async () => {
            const result = await operation();
            await this.armAlarm(await this.readAllocation());
            return result;
          }),
        eligible: route => this.workspaceSnapshotRouteEligible(route),
        stored: async () => this.broadcastStatusSnapshots(await this.readAllocation()),
        read: async () => {
          const state = await this.readAllocation();
          const socket = this.boundWrapperSocket(state);
          return {
            state,
            routes: await listRoutes(this.db),
            capable:
              this.pendingControlRequests.size === 0 &&
              socket !== null &&
              this.readAttachment(socket)?.workspaceSnapshots === true,
          };
        },
      });
    } catch (error) {
      logControlDiagnostic('workspace_snapshot_capture_failed', {
        sandboxId: this.sandboxId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.workspaceSnapshotCapturePending = false;
      await this.enqueue(async () => this.armAlarm(await this.readAllocation()));
    }
  }

  async abort(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneDispatchResult> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(() => {
      this.fenceWorkspaceSnapshot('abort', parsed.sessionId);
      return this.dispatchToWrapper({ type: 'session.abort', sessionId: parsed.sessionId });
    });
  }

  async answer(payload: ControlPlaneAnswerPayload): Promise<ControlPlaneDispatchResult> {
    await this.initialized;
    const parsed = controlPlaneAnswerPayloadSchema.parse(payload);
    return this.enqueue(() =>
      this.dispatchToWrapper({
        type: 'session.answer',
        sessionId: parsed.sessionId,
        reply: parsed.reply,
      })
    );
  }

  async release(payload: ControlPlaneSessionRefPayload): Promise<void> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    await this.enqueue(async () => {
      this.notifications.retire(parsed.sessionId);
      await this.ctx.storage.delete(`${COMMAND_FAILURE_NOTE_KEY_PREFIX}${parsed.sessionId}`);
      this.fenceWorkspaceSnapshot('release', parsed.sessionId);
      const released = await readRoute(this.db, parsed.sessionId);
      // A shared canonical handle survives on the other members, so removing
      // this route's path rules is not worth a policy rebuild: a transient
      // provider failure there would stop the sandbox and kill the survivor. The
      // facade already denies the released root. Last-member release, a real
      // alias retirement and wrapper replacement still rebuild fail-closed.
      const sharedHandleSurvives = sharedCanonicalHandleSurvivesRelease(
        released?.grant ?? null,
        parsed.sessionId
      );
      await deleteRoute(this.db, this.ctx.storage.kv, parsed.sessionId);
      if (!sharedHandleSurvives) {
        // Rebuild the policy inside the queue; if it cannot apply, stop the
        // sandbox as a platform failure so the alias is not left injected.
        await this.applyVercelNetworkPolicyOrStop('sandbox_lost');
      }
      const state = await this.readAllocation();
      await this.armAlarm(state);
      const socket = this.boundWrapperSocket(state);
      if (socket !== null) {
        this.trySendFrame(socket, { type: 'session.release', sessionId: parsed.sessionId });
      }
    });
  }

  /**
   * The workspace snapshot owner of one route, or null when the route has no
   * registered workspace identity. Every recovery read/write validates through
   * this so a caller cannot address another workspace.
   */
  private routeWorkspaceSnapshotIdentity(route: RouteRecord | null) {
    if (route === null || route.credentialSource === null) return null;
    return workspaceSnapshotIdentity(this.sandboxId, route.spec.directory, route.credentialSource);
  }

  /**
   * Session DO -> Sandbox DO (explicit user "Start fresh"). Removes the
   * descriptor of the caller's own workspace only, and only while a recovery
   * offer exists: a newer capture clears the offer, so this never discards a
   * descriptor newer than the one the start failed on. Idempotent.
   */
  async removeWorkspaceSnapshot(
    payload: ControlPlaneSessionRefPayload
  ): Promise<{ success: true }> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(async () => {
      const owner = this.routeWorkspaceSnapshotIdentity(await readRoute(this.db, parsed.sessionId));
      if (owner === null) return { success: true };
      const recovery = readWorkspaceSnapshotAllocation(this.db);
      if (recovery?.owner.workspaceId !== owner.workspaceId || recovery.recovery === undefined)
        return { success: true };
      deleteWorkspaceSnapshot(this.db, owner.workspaceId, 'user_removed', parsed.sessionId);
      // The explicit action is also the recovery acknowledgement: a later start
      // must not keep offering "Start fresh" for the discarded snapshot.
      this.fenceWorkspaceSnapshot('user_removed', parsed.sessionId);
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (disk !== undefined) {
        writeWorkspaceSnapshotAllocation(this.db, {
          ...disk,
          restore: undefined,
          recovery: undefined,
        });
      }
      const state = await this.readAllocation();
      // The sandbox that failed the restore must not be adopted by the next
      // start; Start fresh promises a new sandbox.
      if (recovery.recovery.allocationId === state.allocationId) {
        await this.applyEvent({
          type: 'stop-requested',
          at: Date.now(),
          reason: 'workspace_setup_failed',
        });
        return { success: true };
      }
      await this.armAlarm(state);
      return { success: true };
    });
  }

  /**
   * Session DO -> Sandbox DO. The descriptor this route's most recent
   * preparation actually failed to restore, or null. Descriptor existence alone
   * is not a recovery state. `capturedAt` is null when the stored descriptor is
   * unreadable or foreign: it still blocks every start, so "Start fresh" stays
   * available without a trustworthy capture time.
   */
  async getWorkspaceSnapshotRecovery(
    payload: ControlPlaneSessionRefPayload
  ): Promise<{ capturedAt: number | null } | null> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(async () => {
      const route = await readRoute(this.db, parsed.sessionId);
      if (route?.state !== 'failed') return null;
      const owner = this.routeWorkspaceSnapshotIdentity(route);
      if (owner === null) return null;
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (disk === undefined || disk.owner.workspaceId !== owner.workspaceId) return null;
      if (disk.recovery === undefined) return null;
      if (readWorkspaceSnapshotRaw(this.db, owner.workspaceId) === undefined) return null;
      const descriptor = readWorkspaceSnapshot(this.db, owner.workspaceId);
      if (descriptor === null || !sameWorkspaceSnapshotIdentity(descriptor, owner)) {
        return { capturedAt: null };
      }
      return { capturedAt: descriptor.capturedAt };
    });
  }

  async status(payload: ControlPlaneSessionRefPayload): Promise<ControlPlaneStatusResult> {
    await this.initialized;
    const parsed = controlPlaneSessionRefPayloadSchema.parse(payload);
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      const route = await readRoute(this.db, parsed.sessionId);
      return {
        sessionId: parsed.sessionId,
        view: await this.withContainer(
          routeView(route, state.kind === 'connected', sandboxPreparationProgress(state)),
          state
        ),
      };
    });
  }

  /**
   * The wrapper identity bound to the connected allocation (B10 terminals).
   * Null while no wrapper is connected, so the Session DO never stamps a record
   * with a stale identity.
   */
  async getWrapperId(): Promise<string | null> {
    await this.initialized;
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      return state.kind === 'connected' ? state.wrapperId : null;
    });
  }

  /**
   * Worker -> Sandbox DO (spec §6 "Billing, credentials and deletion"). Port of
   * the legacy DO cleanup: when the provider stop or the shared runtime is
   * confirmed, the worktree's routes are removed; otherwise it throws
   * `WorktreeDeletionIncompleteError`, which the Worker reports as an
   * incomplete, retryable result. Exclusivity is V2-native: the sandbox is
   * destroyed only when the deleted worktree owns the last route.
   *
   * The bounded provider call runs between two serial-queue phases, so a slow
   * provider cannot stall a sibling's hello/events/status (like worktreeCapture).
   */
  async deleteWorktreeResources(
    input: ControlPlaneWorktreeDeletionInput
  ): Promise<{ deleted: true; sessionIds: string[] }> {
    await this.initialized;
    const parsed = controlPlaneWorktreeDeletionInputSchema.parse(input);
    if (parsed.location.sandboxId !== this.sandboxId) {
      throw new Error('Worktree deletion location does not match this sandbox');
    }

    // Phase 1 (serial queue): owner admission, route/state reads, journal
    // decision. No provider call here.
    const handoff = await this.enqueue(async () => {
      await this.initializeOwner(parsed.kiloUserId);
      const routes = await listRoutes(this.db);
      if (deleteWorkspaceSnapshot(this.db, parsed.worktreeId, 'workspace_deleted'))
        this.broadcastStatusSnapshots(await this.readAllocation());
      this.fenceWorkspaceSnapshot('workspace_deleted');
      const target = worktreeOwnedRoutes(routes, parsed);
      const state = await this.readAllocation();
      return {
        // The checkout directory comes from the request, not the routes, so a
        // connected shared sandbox with no route for this worktree still cleans
        // up (legacy `getWorktreeWorkspacePath` parity).
        directory: getWorktreeWorkspacePath(
          parsed.organizationId ?? null,
          parsed.kiloUserId,
          parsed.worktreeId
        ),
        plan: await beginWorktreeDeletion({
          request: parsed,
          exclusive: routes.length === target.length,
          storage: this.ctx.storage,
          allocation: state,
          hasConnection: this.boundWrapperSocket(state) !== null,
        }),
        targetSessionIds: target.map(route => route.sessionId),
      };
    });

    if (handoff.plan.action === 'replay') {
      return { deleted: true, sessionIds: handoff.plan.journal.sessionIds };
    }

    if (handoff.plan.action === 'shared') {
      // Phase 2 (off-queue): clean up the shared checkout through the wrapper
      // (R2). The bounded request awaits run outside the serial queue, exactly
      // like worktree captures.
      const cleanup = await this.runSharedWorktreeCleanup(
        parsed.worktreeId,
        handoff.directory,
        handoff.plan
      );
      // Phase 3 (serial queue): apply the confirmed result.
      return this.enqueue(async () => {
        if (!cleanup.ok) {
          throw new WorktreeDeletionIncompleteError('Shared worktree cleanup is not confirmed');
        }
        await this.revokeWorktreeRoutes(handoff.targetSessionIds);
        this.worktreeChanges.purge(parsed.worktreeId);
        const journal = await finishWorktreeDeletion(
          this.ctx.storage,
          parsed.worktreeId,
          handoff.plan,
          cleanup.sessionIds
        );
        return { deleted: true, sessionIds: journal.sessionIds };
      });
    }

    // Phase 2 (off-queue): the bounded provider stop or observation.
    const confirmed = await this.confirmWorktreeRemoval(handoff.plan);

    // Phase 3 (serial queue): apply the confirmed result.
    return this.enqueue(async () => {
      if (!confirmed) {
        throw new WorktreeDeletionIncompleteError(
          handoff.plan.action === 'stop'
            ? 'Worktree provider stop is unconfirmed'
            : 'Shared worktree runtime must reconnect before cleanup'
        );
      }
      // Revoke the worktree's routes/grants even for a confirmed stop, so a
      // failed route cannot keep the sandbox looking shared forever.
      await this.revokeWorktreeRoutes(handoff.targetSessionIds);
      this.worktreeChanges.purge(parsed.worktreeId);
      if (handoff.plan.action === 'stop') {
        // Fence by allocation identity: a sibling prepare may have created a new
        // allocation while the provider stop ran off-queue.
        const current = await this.readAllocation();
        if (current.allocationId === handoff.plan.allocationId) {
          await this.applyEvent({ type: 'provider-gone', at: Date.now() });
        }
      }
      const journal = await finishWorktreeDeletion(
        this.ctx.storage,
        parsed.worktreeId,
        handoff.plan
      );
      return { deleted: true, sessionIds: journal.sessionIds };
    });
  }

  /**
   * R2 shared checkout cleanup: ask the wrapper to prepare the deletion manifest
   * and then delete it. Mirrors the legacy `shared_wrapper` path: discovery first
   * so the wrapper's `deleteWorktree` manifest does not grow, then delete, then
   * require the wrapper to confirm every discovered session. A failed or
   * unconfirmed step reports incomplete, so the caller retries.
   */
  private async runSharedWorktreeCleanup(
    worktreeId: string,
    directory: string,
    plan: WorktreeDeletionPlan
  ): Promise<{ ok: true; sessionIds: string[] } | { ok: false }> {
    try {
      const discovery = await this.forwardWorktreeDeletion(
        worktreeId,
        directory,
        plan.journal.sessionIds,
        'prepareDeletion'
      );
      if (discovery === null) return { ok: false };
      const prepared = worktreePrepareDeletionResultSchema.safeParse(discovery);
      if (!prepared.success) return { ok: false };
      const manifest = [...new Set([...plan.journal.sessionIds, ...prepared.data.sessionIds])];
      // Persist the discovered manifest before the delete so a delete that
      // removes a child and then fails does not lose that child on retry
      // (legacy `sandbox-control/worktree-deletion.ts` parity).
      await this.enqueue(() =>
        persistWorktreeDeletionManifest(this.ctx.storage, worktreeId, plan.journal, manifest)
      );
      const deleted = await this.forwardWorktreeDeletion(worktreeId, directory, manifest, 'delete');
      if (deleted === null) return { ok: false };
      const confirmed = worktreeDeleteResultSchema.safeParse(deleted);
      if (!confirmed.success) return { ok: false };
      if (manifest.some(sessionId => !confirmed.data.sessionIds.includes(sessionId))) {
        return { ok: false };
      }
      return { ok: true, sessionIds: [...new Set([...manifest, ...confirmed.data.sessionIds])] };
    } catch {
      // Any unexpected failure is still an unconfirmed cleanup (spec §6).
      return { ok: false };
    }
  }

  /**
   * One wrapper worktree-deletion request. Returns null on any failure
   * (`not_ready`, a closed socket, a timeout or a rejected frame) so the caller
   * reports incomplete instead of trusting an unconfirmed cleanup. Uses the
   * legacy attach bound: `deleteWorktree` waits on in-flight directory
   * operations, Kilo calls, retirement and `fs.rm -rf`.
   */
  private async forwardWorktreeDeletion(
    worktreeId: string,
    directory: string,
    sessionIds: readonly string[],
    operation: 'prepareDeletion' | 'delete'
  ): Promise<unknown> {
    const payload = controlPlaneWorktreeDeletionPayloadSchema.parse({
      worktreeId,
      directory,
      sessionIds: [...sessionIds],
    });
    const requestId = crypto.randomUUID();
    const frame: ControlPlaneWrapperFrame =
      operation === 'prepareDeletion'
        ? { type: 'worktree.prepareDeletion', requestId, payload }
        : { type: 'worktree.delete', requestId, payload };
    const handoff = await this.enqueue(() =>
      this.beginWrapperControlRequest(frame, SANDBOX_CONTROL_ATTACH_TIMEOUT_MS)
    );
    const result = 'error' in handoff ? handoff.error : await handoff.promise;
    return result.ok ? result.result : null;
  }

  /** Deletion phase 2: the bounded provider call, outside the serial queue. */
  private async confirmWorktreeRemoval(plan: WorktreeDeletionPlan): Promise<boolean> {
    if (plan.action === 'complete') return true;
    if (plan.action === 'stop') {
      return this.stopProviderConfirmed(plan.providerRef, plan.allocationId);
    }
    return (await this.observeWorktreeRuntime(plan.providerRef)).status === 'terminal';
  }

  private async notifyWorktreeChangesReady(
    context: WorktreeChangesContext,
    revision: number
  ): Promise<void> {
    const worktreeId = context.worktreeId;
    if (!worktreeId) return;
    const sessionIds = new Set([context.session.sessionId]);
    for (const [, sessionId] of this.ctx.storage.kv.list({
      prefix: worktreeSubscriberKey(worktreeId, ''),
    })) {
      sessionIds.add(z.string().parse(sessionId));
    }
    for (const route of await listRoutes(this.db)) {
      if (
        route.credentialSource?.scopeId === worktreeId ||
        route.spec.directory === context.session.directory
      ) {
        sessionIds.add(route.sessionId);
      }
    }
    for (const sessionId of sessionIds) {
      this.notifications.enqueue(sessionId, {
        kind: 'worktree_changes',
        payload: { worktreeId, revision },
      });
    }
  }

  private subscribeToWorktreeChanges(context: WorktreeChangesContext): void {
    const { worktreeId, session } = context;
    if (
      !worktreeId ||
      this.ctx.storage.kv.get(`${WORKTREE_DELETION_PREFIX}${worktreeId}`) !== undefined
    ) {
      return;
    }
    const key = worktreeSubscriberKey(worktreeId, session.sessionId);
    if (this.ctx.storage.kv.get(key) === undefined) {
      this.ctx.storage.kv.put(key, session.sessionId);
    }
  }

  async getWorktreeChanges(input: SharedWorktreeChangesInput): Promise<GetWorktreeChangesOutput> {
    await this.initialized;
    this.subscribeToWorktreeChanges(input.context);
    return this.worktreeChanges.get(input);
  }

  async getWorktreeFile(
    input: SharedWorktreeChangesInput,
    query: unknown
  ): Promise<GetWorktreeFileOutput> {
    await this.initialized;
    this.subscribeToWorktreeChanges(input.context);
    return this.worktreeChanges.getFile(input, query);
  }

  async refreshWorktreeChanges(
    input: SharedWorktreeChangesInput
  ): Promise<RefreshWorktreeChangesOutput> {
    await this.initialized;
    this.subscribeToWorktreeChanges(input.context);
    return this.worktreeChanges.refresh(input);
  }

  async getWorktreeRecovery(
    input: SharedWorktreeChangesInput
  ): Promise<WorktreeRecovery | undefined> {
    await this.initialized;
    this.subscribeToWorktreeChanges(input.context);
    return this.worktreeChanges.recovery(input);
  }

  /**
   * Session DO -> Sandbox DO (spec §10). Forwards one worktree-change request
   * to the wrapper and returns its result.
   */
  async worktreeCapture(
    input: ControlPlaneWorktreeCaptureInput
  ): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneWorktreeCaptureInputSchema.parse(input);
    // Only the bound socket, the pending entry and the write happen under the
    // serial queue. The wrapper's reply is awaited OUTSIDE it, so a capture
    // cannot stall `session.events`/`outcome`/`deliver`/the alarm for 30 s
    // (spec §10: RPCs return at once).
    const handoff = await this.enqueue(async () => this.beginWorktreeCapture(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginWorktreeCapture(
    input: ControlPlaneWorktreeCaptureInput
  ): Promise<ControlRequestHandoff> {
    const requestId = crypto.randomUUID();
    const frame: ControlPlaneWrapperFrame =
      input.operation === 'snapshot'
        ? { type: 'worktree.snapshot', requestId, session: input.session, payload: input.payload }
        : { type: 'worktree.summary', requestId, session: input.session, payload: input.payload };
    return this.beginWrapperControlRequest(frame);
  }

  /**
   * Session DO -> Sandbox DO. Forwards one Sync/Restack request to the wrapper
   * and returns its shared `worktreeBranchOperationResult`. The reply budget is
   * the longer git-operation bound (fetch + rebase + push), not the 30s
   * capture bound: these operations force-push with a lease, so a premature
   * timeout would report failure for work that then completes.
   */
  async worktreeGit(input: ControlPlaneWorktreeGitInput): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneWorktreeGitInputSchema.parse(input);
    const handoff = await this.enqueue(() => this.beginWorktreeGit(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginWorktreeGit(
    input: ControlPlaneWorktreeGitInput
  ): Promise<ControlRequestHandoff> {
    const requestId = crypto.randomUUID();
    const frame: ControlPlaneWrapperFrame = {
      type: 'worktree.git',
      requestId,
      session: input.session,
      payload: input.payload,
    };
    // A lost reply after a lease push leaves the outcome unknown, so a timeout must not invite a retry.
    return this.beginWrapperControlRequest(
      frame,
      CONTROL_PLANE_WORKTREE_GIT_TIMEOUT_MS,
      controlRequestFailure(
        'operation_outcome_unknown',
        'The sandbox did not answer the branch operation in time; it may have completed',
        false
      )
    );
  }

  /**
   * Session DO -> Sandbox DO (spec §10). Forwards exactly one terminal
   * create/resize/close/connect request to the wrapper and returns its result.
   * Like worktree captures, only the bind/pending/write happen under the serial
   * queue; the reply is awaited outside it.
   */
  async terminal(input: ControlPlaneTerminalInput): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneTerminalInputSchema.parse(input);
    const handoff = await this.enqueue(() => this.beginTerminalRequest(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginTerminalRequest(
    input: ControlPlaneTerminalInput
  ): Promise<ControlRequestHandoff> {
    this.fenceWorkspaceSnapshot('terminal', input.session.sessionId);
    return this.beginWrapperControlRequest(terminalRequestFrame(crypto.randomUUID(), input));
  }

  /**
   * Session DO -> Sandbox DO (spec §10). Forwards one allowlisted native Kilo
   * read to the live wrapper. It never starts or wakes an allocation: only a
   * bound wrapper socket answers, so a stopped session returns `not_ready`
   * without any provider call. The socket binding is the allocation and
   * connection fence, so a superseded wrapper cannot answer for its successor.
   */
  async kiloRequest(input: ControlPlaneKiloRequestInput): Promise<ControlPlaneControlResult> {
    await this.initialized;
    const parsed = controlPlaneKiloRequestInputSchema.parse(input);
    const handoff = await this.enqueue(() => this.beginKiloRequest(parsed));
    return 'error' in handoff ? handoff.error : handoff.promise;
  }

  private async beginKiloRequest(
    input: ControlPlaneKiloRequestInput
  ): Promise<ControlRequestHandoff> {
    const frame: ControlPlaneWrapperFrame = {
      type: 'kilo.request',
      requestId: crypto.randomUUID(),
      session: input.session,
      operation: input.operation,
    };
    return this.beginWrapperControlRequest(frame);
  }

  /**
   * Off-queue read the Session DO uses to resolve one preview's provider
   * coordinates. It never enqueues, so a preview never waits behind the control
   * operation queue. The allocation and route are two separate reads, not one
   * snapshot. A target that changes before the upstream fetch is fenced
   * downstream: SandboxContainers checks `allocationRef` and state, and the
   * remaining race is an accepted residual (control-plane.md, Preview).
   */
  async previewTarget(sessionId: string): Promise<PreviewTargetResult> {
    await this.initialized;
    const allocation = await this.readAllocation();
    const route = await readRoute(this.db, sessionId);
    return resolvePreviewTarget({
      routeState: route?.state ?? null,
      allocationKind: allocation.kind,
      providerRef: allocation.providerRef,
      provider: this.currentProvider(),
      logicalSandboxId: this.sandboxId,
    });
  }

  /**
   * Session DO -> Sandbox DO live preview discovery. Route/allocation state is
   * read off the operation queue first, so a stopped sandbox returns
   * `not_running` and a preparing one `not_ready` without any provider call or
   * wake. Only a bound wrapper socket is asked to scan; its reply is awaited
   * outside the queue like every other control request.
   */
  async previewServices(sessionId: string): Promise<ListPreviewServicesOutput> {
    await this.initialized;
    const target = await this.previewTarget(sessionId);
    if (target.status === 'unsupported_provider') {
      return { services: [], status: 'unsupported' };
    }
    if (target.status === 'not_ready') return { services: [], status: 'not_ready' };
    if (target.status === 'not_running') return { services: [], status: 'not_running' };

    const handoff = await this.enqueue(() => this.beginPreviewServicesRequest());
    if ('error' in handoff) {
      if (handoff.error.ok) throw new Error('Unexpected preview service scan result');
      return this.previewServicesHandoffFailure(handoff.error.error);
    }
    const result = await handoff.promise;
    if (!result.ok) this.previewServicesFailure(result.error);
    const parsed = PreviewServicesScanSchema.safeParse(result.result);
    if (!parsed.success) throw new Error('Invalid preview service scan result');
    return { services: parsed.data.services, status: 'running' };
  }

  private async beginPreviewServicesRequest(): Promise<ControlRequestHandoff> {
    return this.beginWrapperControlRequest(
      {
        type: 'preview.list',
        requestId: crypto.randomUUID(),
      },
      Math.min(this.controlRequestTimeoutMs, PREVIEW_SERVICES_CONTROL_TIMEOUT_MS)
    );
  }

  private previewServicesHandoffFailure(
    error: ControlPlaneRequestError
  ): ListPreviewServicesOutput {
    if (PRE_SEND_NOT_READY_MESSAGES.has(error.message)) {
      return { services: [], status: 'not_ready' };
    }
    return this.previewServicesFailure(error);
  }

  private previewServicesFailure(error: ControlPlaneRequestError): never {
    if (error.message === WRAPPER_REQUEST_TIMED_OUT) {
      throw new Error('Preview service discovery timed out');
    }
    throw new Error(`Preview service scan failed (${error.code})`);
  }

  /**
   * Binds one request frame to the connected socket under the serial queue and
   * registers it in the pending map. The wrapper's reply is resolved on the raw
   * socket path, so callers await the returned promise OUTSIDE the queue (spec
   * §10: RPCs return at once). Shared by worktree captures, terminals and the R2
   * worktree-deletion frames. `timeoutMs` overrides the default request bound
   * for operations with a longer legacy bound (worktree deletion).
   */
  private async beginWrapperControlRequest(
    frame: Extract<ControlPlaneWrapperFrame, { requestId: string }>,
    timeoutMs: number = this.controlRequestTimeoutMs,
    timeoutFailure?: ControlPlaneControlResult
  ): Promise<ControlRequestHandoff> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) {
      return { error: controlRequestFailure('not_ready', WRAPPER_NOT_CONNECTED, true) };
    }
    if (frame.type === 'worktree.git' && this.readAttachment(socket)?.worktreeGit !== true) {
      return {
        error: controlRequestFailure(
          'wrapper_upgrade_required',
          'This sandbox must restart with an updated runtime before using Sync or Restack.',
          false
        ),
      };
    }
    if (this.pendingControlRequests.size >= MAX_PENDING_CONTROL_REQUESTS) {
      return {
        error: controlRequestFailure('busy', 'Too many outstanding control requests', true),
      };
    }
    const promise = this.registerPendingControlRequest(
      frame.requestId,
      socket,
      timeoutMs,
      timeoutFailure
    );
    if (!this.trySendFrame(socket, frame)) {
      this.settlePendingControlRequest(
        frame.requestId,
        controlRequestFailure('not_ready', WRAPPER_WRITE_FAILED, true)
      );
      return { error: controlRequestFailure('not_ready', WRAPPER_WRITE_FAILED, true) };
    }
    return { promise };
  }

  private registerPendingControlRequest(
    requestId: string,
    socket: WebSocket,
    timeoutMs: number = this.controlRequestTimeoutMs,
    timeoutFailure = controlRequestFailure('not_ready', WRAPPER_REQUEST_TIMED_OUT, true)
  ): Promise<ControlPlaneControlResult> {
    return new Promise<ControlPlaneControlResult>(resolve => {
      const timer = setTimeout(() => {
        this.pendingControlRequests.delete(requestId);
        resolve(timeoutFailure);
      }, timeoutMs);
      this.pendingControlRequests.set(requestId, { socket, resolve, timer });
    });
  }

  private settlePendingControlRequest(requestId: string, result: ControlPlaneControlResult): void {
    const pending = this.pendingControlRequests.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingControlRequests.delete(requestId);
    pending.resolve(result);
  }

  /**
   * Resolves every request bound to a closed socket at once, so a dropped
   * wrapper does not leave callers waiting the full request timeout.
   */
  private settlePendingForSocket(socket: WebSocket, result: ControlPlaneControlResult): void {
    for (const [requestId, pending] of this.pendingControlRequests) {
      if (pending.socket === socket) this.settlePendingControlRequest(requestId, result);
    }
  }

  /**
   * Resolves a pending control request from a wrapper result frame. Runs on the
   * raw socket message path (before the serial queue) so a queued request that
   * awaits its own result cannot deadlock the queue.
   */
  private resolvePendingControlResult(ws: WebSocket, message: string | ArrayBuffer): void {
    let parsed: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isCorrelatedResultFrame(parsed)) {
      return;
    }
    const result = controlPlaneWrapperFrameSchema.safeParse(parsed);
    if (!result.success || !isCorrelatedResultFrame(result.data)) {
      return;
    }
    const frame = result.data;
    if (this.pendingControlRequests.get(frame.requestId)?.socket !== ws) return;
    this.settlePendingControlRequest(
      frame.requestId,
      frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error }
    );
  }

  /**
   * Contained outbound credential lookup (spec §6/§10), same request shape as
   * `src/sandbox-outbound.ts` calls today. Matches the grant by alias, re-checks
   * expiry/containment, resolves and persists the refreshed grant.
   */
  async resolveCredential(input: {
    credential: string;
    outboundContainerId: string;
    url: string;
    method: string;
  }): Promise<{ credential: string } | null> {
    await this.initialized;
    try {
      const result = await admitScmRequest(
        {
          target: { url: input.url, method: input.method },
          authorization: { authorization: `Bearer ${input.credential}` },
        },
        {
          ...this.scmAdmissionDependencies(),
          readContext: async () => {
            const context = await this.readScmAdmissionContext();
            return {
              ...context,
              available: providerUsesOutboundCredentialProxy(context.provider),
              identityBinding: '',
            };
          },
          // Only the platform outbound handler supplies this container identity.
          authenticate: async context =>
            context.outboundContainerId === input.outboundContainerId
              ? { ok: true, isCurrent: () => true }
              : { ok: false, status: 403, code: 'invalid_identity' },
        }
      );
      return result.ok && result.authority.type === 'managed'
        ? { credential: result.authority.capability }
        : null;
    } catch {
      return null;
    }
  }

  async admitScmForward(
    input: ControlPlaneScmForwardAdmission
  ): Promise<ControlPlaneScmForwardAdmissionResult> {
    await this.initialized;
    return admitVercelScmForward(input, {
      ...this.scmAdmissionDependencies(),
      env: this.env,
      contract: verifiedVercelSandboxIdentityContract,
      readContext: () => this.readScmAdmissionContext(),
    });
  }

  private scmAdmissionDependencies() {
    return {
      serial: <T>(operation: () => Promise<T>) => this.enqueue(operation),
      resolve: (request: Omit<Parameters<typeof resolveSessionCredential>[0], 'env'>) =>
        resolveSessionCredential({ ...request, env: this.env }),
      persist: (grant: SessionCredentialGrant) => writeScopeGrant(this.db, grant),
    };
  }

  private async readScmAdmissionContext() {
    const allocation = await this.readAllocation();
    return {
      sandboxId: this.sandboxId,
      ownerId: await this.requireOwner(),
      provider: this.currentProvider(),
      containmentEnabled: this.credentialContainmentEnabled(),
      allocation,
      outboundContainerId:
        allocation.kind === 'stopped' || allocation.kind === 'stopping'
          ? null
          : this.outboundContainerIdFor(),
      physicalName: this.providerPin?.allocationName ?? this.sandboxId,
      byoc: this.providerPin?.byoc,
      locator: this.providerPin?.locator ?? null,
      grants: listScopeGrants(this.db),
      liveSessionIds: (await listRoutes(this.db))
        .filter(route => route.state !== 'failed')
        .map(route => route.sessionId),
    };
  }

  /**
   * Runtime credential proxy fence (spec §10), keyed on the routed session. The
   * proxy authorizes a handle against this fence before binding it.
   */
  async getRuntimeCredentialProxyFence(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle?: string;
  }): Promise<ControlRuntimeCredentialProxyFenceScope | null> {
    await this.initialized;
    if (
      typeof input.ownerId !== 'string' ||
      typeof input.sessionId !== 'string' ||
      typeof input.kiloSessionId !== 'string' ||
      typeof input.directory !== 'string'
    ) {
      return null;
    }
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      const fence = this.runtimeProxyFenceFor(state);
      if (fence === null) return null;
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) return null;
      const route = await readRoute(this.db, input.sessionId);
      if (route?.state === 'failed') return null;
      const grant = route?.grant ?? null;
      const provisioned =
        grant !== null &&
        grant.userId === input.ownerId &&
        grant.directory === input.directory &&
        grant.expiresAt > Date.now() &&
        grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
        );
      if (!provisioned || route === null) return null;
      if (
        route.spec.kiloSessionId !== input.kiloSessionId ||
        route.spec.directory !== input.directory
      ) {
        return null;
      }
      if (typeof input.handle !== 'string' || input.handle.length === 0) return fence;
      const match = await lookupAcceptedHandle(this.ctx.storage, input.handle, fence);
      if (match === undefined) return fence;
      // `provisioned` already checked the route grant's directory and the caller's
      // membership; tying it to the accepted entry makes the canonical view grant
      // the caller's own grant, so a handle accepted under another scope cannot
      // attach that scope's view.
      if (scopeGrantId(grant) !== match.scopeGrantId) {
        return {
          ...fence,
          scopeViewUnavailable: 'Accepted scope handle does not belong to the caller grant',
        };
      }
      const scopeGrant = readScopeGrant(this.db, match.scopeGrantId);
      if (scopeGrant === null) {
        return {
          ...fence,
          scopeViewUnavailable: 'Accepted scope handle has no canonical grant',
        };
      }
      return { ...fence, scopeView: readScopeGrantView(this.db, scopeGrant) };
    });
  }

  /** Binds a verified runtime credential proxy handle to the route's grant. */
  async bindRuntimeCredentialProxyHandle(input: {
    ownerId: string;
    sessionId: string;
    kiloSessionId: string;
    directory: string;
    handle: string;
  }): Promise<{ bound: true }> {
    await this.initialized;
    if (
      typeof input.handle !== 'string' ||
      input.handle.length === 0 ||
      input.handle.length > 4096
    ) {
      throw new Error('Invalid runtime credential proxy handle');
    }
    return this.enqueue(async () => {
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) {
        throw new Error('Sandbox owner mismatch');
      }
      const route = await readRoute(this.db, input.sessionId);
      const grant = route?.grant ?? null;
      if (
        route === null ||
        route.state === 'failed' ||
        grant === null ||
        grant.userId !== input.ownerId ||
        grant.directory !== input.directory ||
        grant.expiresAt <= Date.now() ||
        !grant.members.some(
          member =>
            member.sessionId === input.sessionId && member.kiloSessionId === input.kiloSessionId
        ) ||
        grant.kilo.runtimeProxy === undefined
      ) {
        throw new Error('Session has no matching runtime proxy credential grant');
      }
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, input.handle);
      if (
        !claims ||
        !('sessionId' in claims) ||
        claims.userId !== input.ownerId ||
        claims.sessionId !== input.sessionId ||
        claims.kiloSessionId !== input.kiloSessionId
      ) {
        throw new Error('Invalid runtime credential proxy member handle');
      }
      const updated: SessionCredentialGrant = {
        ...grant,
        kilo: {
          ...grant.kilo,
          runtimeProxy: {
            ...grant.kilo.runtimeProxy,
            members: [
              ...grant.kilo.runtimeProxy.members.filter(
                member => member.sessionId !== input.sessionId
              ),
              {
                sessionId: input.sessionId,
                kiloSessionId: input.kiloSessionId,
                handle: input.handle,
              },
            ],
          },
        },
      };
      if (!(await this.applyCandidateGrantPolicy(updated))) {
        throw new Error('Sandbox credential policy is unavailable');
      }
      writeScopeGrant(this.db, updated);
      return { bound: true };
    });
  }

  /**
   * Serves a runtime credential proxy handle on behalf of a surviving member of
   * the canonical scope. The exact handle string is supplied and its signature
   * is re-verified here. `unavailable` means a candidate failed on transport and
   * none served (the facade returns a retryable 503); `denied` is a known denial
   * on every candidate (including a handle not in the accepted set).
   */
  async resolveScopeHandle(input: { handle: string }): Promise<ScopeHandleResolution> {
    await this.initialized;
    if (
      typeof input?.handle !== 'string' ||
      input.handle.length === 0 ||
      input.handle.length > 4096
    ) {
      return { type: 'denied' };
    }
    const claims = await verifyRuntimeCredentialProxyHandle(this.env, input.handle);
    if (!claims) return { type: 'denied' };
    const owner = await this.requireOwner();
    if (owner === null || owner !== claims.userId) return { type: 'denied' };
    const fence = this.runtimeProxyFenceFor(await this.readAllocation());
    if (fence === null) return { type: 'denied' };
    const match = await lookupAcceptedHandle(this.ctx.storage, input.handle, fence);
    if (match === undefined) return { type: 'denied' };

    const grant = readScopeGrant(this.db, match.scopeGrantId);
    if (grant === null || grant.userId !== claims.userId) {
      return this.denyScopeHandle(match.scopeGrantId);
    }
    const candidates = selectScopeHandleCandidates({
      grant,
      routes: await listRoutes(this.db),
      issuerSessionId: claims.sessionId,
    });
    if (candidates.length === 0) return this.denyScopeHandle(match.scopeGrantId);

    let sawUnavailable = false;
    for (const candidate of candidates) {
      const peer = this.sessionPeerFor(owner, candidate.member.sessionId);
      if (peer === null) {
        sawUnavailable = true;
        continue;
      }
      let backing: ScopeBackingToken | null;
      try {
        backing = await withTimeout(
          peer.issueRuntimeProxyBackingToken({
            sandboxId: this.sandboxId,
            ...expectedScopeForCandidate(candidate.member, grant),
          }),
          this.scopeBackingTokenMs(),
          'Scope backing token timed out'
        );
      } catch {
        sawUnavailable = true;
        continue;
      }
      if (backing === null) continue;

      // The renewal awaited external I/O. A superseded physical binding or a
      // vanished grant makes the handle stale, not the member's fault: deny
      // without failing routes. A member that left the grant, or whose route
      // directory/root drifts while renewing, is a member-level denial and the
      // next candidate is tried.
      const latestFence = this.runtimeProxyFenceFor(await this.readAllocation());
      const latestGrant = readScopeGrant(this.db, match.scopeGrantId);
      const latestRoutes = await listRoutes(this.db);
      const latestRoute = latestRoutes.find(
        route => route.sessionId === candidate.member.sessionId
      );
      const decision = decideRenewedScopeCandidate({
        bindingMatches: latestFence !== null && sameRuntimeProxyControlBinding(fence, latestFence),
        grant: latestGrant,
        member: candidate.member,
        route: latestRoute,
      });
      if (decision === 'deny') return { type: 'denied' };
      if (decision === 'skip') continue;
      if (latestGrant === null) return { type: 'denied' };
      if (!scopeBackingMatchesGrant(backing, candidate.member, latestGrant)) continue;
      return {
        type: 'served',
        scopeView: buildScopeGrantView(latestGrant, latestRoutes),
        ...backing,
      };
    }
    if (sawUnavailable) return { type: 'unavailable' };
    return this.denyScopeHandle(match.scopeGrantId);
  }

  /** Locator for a deleted issuer that still has accepted handles, or null. */
  async getAcceptedHandleIssuerLocator(issuerSessionId: string): Promise<{
    scopeId: string;
    allocationId: string;
    wrapperInstanceId: string;
    expiresAt: number;
  } | null> {
    await this.initialized;
    if (typeof issuerSessionId !== 'string' || issuerSessionId.length === 0) return null;
    return acceptedHandleIssuerLocator(this.ctx.storage, issuerSessionId);
  }

  /**
   * Fails every ready route in the scope in the background, then denies the
   * handle immediately so the facade response is not held behind the queue.
   */
  private denyScopeHandle(scopeGrantId: string): ScopeHandleResolution {
    this.ctx.waitUntil(
      this.enqueue(async () => {
        const state = await this.readAllocation();
        await failReadyRoutesForScope(
          this.routeContext(state),
          scopeGrantId,
          'scope_handle_denied'
        );
      })
    );
    return { type: 'denied' };
  }

  /**
   * Vercel network policy entry point (spec §10 runtime credential proxy). The
   * caller-supplied `networkPolicy` is accepted for RPC compatibility but its
   * value is ignored: the policy is rebuilt from the stored grants so this
   * cannot become a second source of truth, and the caller must own the sandbox
   * (B3 review 5).
   */
  async updateNetworkPolicy(input: {
    ownerId: string;
    networkPolicy?: unknown;
    requiredContainment: CredentialContainmentRequirements;
  }): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      const owner = await this.requireOwner();
      if (owner === null || owner !== input.ownerId) {
        throw new Error('Sandbox owner mismatch');
      }
      if (this.currentProvider() !== 'vercel') {
        throw new Error('Sandbox network policy requires a Vercel provider');
      }
      const state = await this.readAllocation();
      if (
        (state.kind !== 'connected' && state.kind !== 'disconnected') ||
        state.providerRef === null
      ) {
        throw new Error('Sandbox network policy requires a running instance');
      }
      if (
        (!input.requiredContainment.kilocode && !input.requiredContainment.github) ||
        !this.matchesContainment(input.requiredContainment)
      ) {
        throw new Error('Sandbox credential containment mismatch');
      }
      if (!(await this.refreshVercelNetworkPolicy())) {
        throw new Error('Sandbox credential policy is unavailable');
      }
    });
  }

  async reportStartupFailure(input: {
    allocationId: string;
    credential: string;
    code: StartupFailureCode;
  }): Promise<boolean> {
    await this.initialized;
    return this.enqueue(async () => {
      const state = await this.readAllocation();
      if (
        (state.kind !== 'creating' && state.kind !== 'starting') ||
        !(await this.validateAllocationCredential(input.allocationId, input.credential))
      )
        return false;
      logControlDiagnostic('runtime_startup_failed', {
        allocationId: input.allocationId,
        code: input.code,
      });
      await this.applyEvent({
        type: 'startup-failed',
        at: Date.now(),
        allocationId: input.allocationId,
        code: input.code,
      });
      return true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    // Only the authorized Session DO forwards this internal path, using stored ownership.
    if (url.pathname === '/status-stream') {
      return this.enqueue(async () => {
        const owner = await this.requireOwner();
        const sessionId = url.searchParams.get('sessionId');
        if (owner === null || owner !== url.searchParams.get('ownerId') || !sessionId)
          return new Response('Sandbox owner mismatch', { status: 403 });
        const allocation = await this.readAllocation();
        const parsedIdentity = workspaceSnapshotIdentitySchema.safeParse({
          sandboxId: this.sandboxId,
          userId: owner,
          workspaceId: url.searchParams.get('workspaceId'),
          directory: url.searchParams.get('directory'),
          orgId: url.searchParams.get('orgId') ?? undefined,
        });
        const identity = parsedIdentity.success ? parsedIdentity.data : null;
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], ['sandbox-status']);
        pair[1].serializeAttachment({ kind: 'sandbox-status', sessionId, identity });
        this.sendStatusSnapshot(pair[1], sessionId, allocation, identity);
        return new Response(null, { status: 101, webSocket: pair[0] });
      });
    }
    const token = parseSandboxLaunchBearer(request.headers.get('Authorization'));
    if (token === null)
      return new Response('Invalid or missing Authorization header', { status: 401 });
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) return new Response('Authentication unavailable', { status: 503 });
    const launch = verifySandboxLaunchCredential(token, secret);
    return this.enqueue(async () => {
      if (
        launch === null ||
        launch.sandboxId !== this.sandboxId ||
        !(await this.validateAllocationCredential(launch.allocationId, launch.credential))
      ) {
        return rejectSandboxWrapperUpgrade();
      }
      this.expireUnboundSockets(Date.now());
      const candidates = this.ctx.getWebSockets().filter(ws => {
        const attachment = this.readAttachment(ws);
        return (
          ws.readyState === WebSocket.OPEN &&
          attachment?.helloDeadlineAt !== undefined &&
          attachment.allocationId === launch.allocationId
        );
      });
      if (candidates.length >= 2) {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(1013, 'Handshake capacity');
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const observedRuntime = readObservedRuntimeVersions(request.headers);
      pair[1].serializeAttachment({
        credential: launch.credential,
        allocationId: launch.allocationId,
        ...(request.headers.get(WORKTREE_RUNTIME_HEADER) === WORKTREE_RUNTIME_VERSION
          ? { runtimeCapability: 'worktree' as const }
          : {}),
        ...(request.headers.get(WORKSPACE_CONFIGURATION_HEADER) === WORKSPACE_CONFIGURATION_VERSION
          ? { workspaceConfiguration: true as const }
          : {}),
        ...runtimeHarnessField(parseRuntimeHarness(request.headers.get(RUNTIME_HARNESS_HEADER))),
        ...(observedRuntime.kiloCliVersion === null
          ? {}
          : { kiloCliVersion: observedRuntime.kiloCliVersion }),
        ...(observedRuntime.wrapperVersion === null
          ? {}
          : { wrapperVersion: observedRuntime.wrapperVersion }),
        helloDeadlineAt: Date.now() + this.sandboxTimers().wrapperHelloMs,
      } satisfies WrapperSocketAttachment);
      await this.armAlarm(await this.readAllocation());
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.initialized;
    if (this.isStatusSocket(ws)) return;
    // Resolve an outstanding control request before the serial queue so the
    // queued request that awaits it cannot block its own reply.
    this.resolvePendingControlResult(ws, message);
    await this.enqueue(() => this.handleFrame(ws, message));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.initialized;
    if (this.isStatusSocket(ws)) {
      ws.close();
      return;
    }
    // Fail every request bound to this socket at once; do not wait the timeout.
    this.settlePendingForSocket(
      ws,
      controlRequestFailure('not_ready', 'Wrapper disconnected', true)
    );
    await this.enqueue(async () => {
      const attachment = this.readAttachment(ws);
      if (attachment?.allocationId === undefined || attachment.connectionId === undefined) {
        ws.serializeAttachment({ credential: null });
        await this.armAlarm(await this.readAllocation());
        return;
      }
      await this.applyEvent({
        type: 'socket-closed',
        at: Date.now(),
        allocationId: attachment.allocationId,
        connectionId: attachment.connectionId,
        origin: 'peer',
      });
    });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    await this.initialized;
    await this.enqueue(async () => {
      this.expireUnboundSockets(Date.now());
      let state = await this.readAllocation();
      await failExpiredRoutes(this.routeContext(state));
      await this.renewDueRouteGrants(state);
      if (
        state.kind === 'stopped' &&
        !this.createInFlight &&
        (await routeRetryAllowed(this.routeContext(state)))
      ) {
        await this.applyEvent({
          type: 'ensure',
          at: Date.now(),
          allocationId: crypto.randomUUID(),
        });
        state = await this.readAllocation();
      }
      if (state.kind === 'creating' && this.createInFlight) {
        // N2: the in-flight attempt owns the create deadline. Keep a backstop;
        // it will dispatch its own result and re-arm.
        await this.ctx.storage.setAlarm(
          Math.min(
            Date.now() + this.sandboxTimers().providerCreateMs,
            (await earliestRouteDeadlineAt(this.db)) ?? Infinity,
            this.earliestHelloDeadlineAt() ?? Infinity
          )
        );
        return;
      }
      await this.applyEvent({
        type: 'tick',
        at: Date.now(),
        nextAllocationId: crypto.randomUUID(),
        retryAllowed: await this.retryAllowed(),
      });
      await this.armAlarm(await this.readAllocation());
    });
    this.ctx.waitUntil(this.captureIdleWorkspaceSnapshot());
  }

  private async initializeStorage(): Promise<void> {
    const generation = await this.ctx.storage.get<unknown>(GENERATION_KEY);
    if (generation === undefined) {
      const cutover = await this.readLegacyCutover();
      const retainedBilling = new Map<string, unknown>();
      for (const prefix of ['container-usage:', 'vercel-billing:']) {
        for (const [key, value] of await this.ctx.storage.list({ prefix })) {
          retainedBilling.set(key, value);
        }
      }
      // Build the adapter before erasing anything. A construction failure must
      // leave the persisted IDs, provider ref and pin available for a retry.
      const pin = this.cutoverPin(cutover);
      const provider = this.createProviderAdapter(pin);
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(GENERATION_KEY, GENERATION);
      await migrate(this.db, migrations);
      for (const [key, value] of retainedBilling) await this.ctx.storage.put(key, value);
      this.providerPin = pin;
      this.provider = provider;
      const state: AllocationState = {
        ...initialAllocationState(),
        ...(cutover.providerRef === null
          ? {}
          : {
              kind: 'stopping' as const,
              providerRef: cutover.providerRef,
              // The backstop is the first ladder attempt: init must not run the
              // stop inline, so the alarm resumes it (H2).
              stopAt: Date.now() + this.sandboxTimers().providerStopAttemptMs,
            }),
      };
      await this.writeAllocation(state);
      await this.writeProviderPin(pin);
      await this.armAlarm(state);
      return;
    }
    await migrate(this.db, migrations);
    this.ctx.storage.kv.delete('session_disk_snapshot:v1');
    this.ctx.storage.kv.delete('session_disk_allocation:v1');
    const row = await this.readAllocationRow();
    if (row === null) return;
    const pin = (await this.readProviderPin()) ?? this.defaultPin('cloudflare');
    this.providerPin = pin;
    this.provider = this.createProviderAdapter(pin);
    let state = rowToState(row);
    const routes = this.db.select().from(routesTable).all();
    if (
      (pin.containment && (!pin.containment.kilocode || !pin.containment.github)) ||
      listScopeGrants(this.db).some(grant => grant.containmentEnabled === false) ||
      routes.some(
        route =>
          route.grant?.trimStart().startsWith('{') ||
          (route.state === 'ready' &&
            route.credential_source !== null &&
            (route.grant === null || readScopeGrant(this.db, route.grant) === null))
      )
    ) {
      // Per-route snapshots do not identify which sibling's aliases the runtime installed.
      const now = Date.now();
      const stopped = reduceAllocation(
        state,
        { type: 'stop-requested', at: now, reason: 'agent_restarted' },
        this.sandboxTimers()
      ).state;
      state =
        state.kind !== 'stopping' && stopped.kind === 'stopping'
          ? { ...stopped, stopPending: true, stopAt: now }
          : stopped;
      this.db.transaction(tx => {
        retireScopeGrants(tx, this.ctx.storage.kv);
        for (const route of routes) {
          tx.update(routesTable)
            .set({
              grant: null,
              ...(route.state === 'failed' ? {} : { state: 'failed', reason: 'agent_restarted' }),
              updated_at: now,
            })
            .where(eq(routesTable.session_id, route.session_id))
            .run();
        }
        tx.update(allocationTable)
          .set(stateToRow(state))
          .where(eq(allocationTable.id, ALLOCATION_ROW_ID))
          .run();
      });
      for (const route of routes) {
        if (route.state === 'failed') continue;
        this.notifications.enqueue(route.session_id, {
          kind: 'route',
          payload: {
            state: route.state === 'ready' ? 'lost' : 'failed',
            attemptId: route.attempt_id,
            reason: 'agent_restarted',
          },
        });
      }
    }
    await this.armAlarm(state);
  }

  private currentProvider(): AgentSandboxProvider {
    return this.providerPin?.provider ?? 'cloudflare-containers';
  }

  private cutoverPin(cutover: LegacyCutover): StoredProviderPin {
    return {
      provider: cutover.provider,
      allocationName: cutover.allocationName ?? this.sandboxId,
      configuration: cutover.configuration ?? { provider: cutover.provider },
      locator: cutover.vercelLocator,
      billing: cutover.billing,
      containment: null,
    };
  }

  private defaultPin(provider: AgentSandboxProvider): StoredProviderPin {
    return {
      provider,
      allocationName: this.sandboxId,
      configuration: { provider },
      locator: null,
      billing: null,
      containment: null,
    };
  }

  private pinFromInput(
    input: EnsureAllocationInput,
    repositoryUrl?: string,
    kiloToken?: string
  ): StoredProviderPin {
    const policy = egressPolicySchema.safeParse(input);
    if (!policy.success) throw new ProviderCreationError('invalid_configuration');
    if (!sandboxKindMatchesKey(this.sandboxId, input.sandboxKind)) {
      throw new Error('Sandbox selection kind does not match the sandbox key');
    }
    const provider = input.provider ?? 'cloudflare-containers';
    if (
      (policy.data.egressMode === 'allowlist' || policy.data.egressAudit === true) &&
      (provider !== 'cloudflare-containers' ||
        (input.sandboxKind === undefined
          ? !this.sandboxId.startsWith('ses-')
          : input.sandboxKind !== 'isolated'))
    ) {
      throw new ProviderCreationError('invalid_configuration');
    }
    if (input.byoc && provider !== 'vercel') throw new Error('BYOC requires Vercel');
    if (provider === 'vercel' && !input.byoc)
      throw new ByocVercelProviderError('byoc_credential_missing');
    return {
      provider,
      allocationName: input.allocationName ?? this.sandboxId,
      configuration: input.configuration ?? { provider },
      locator: input.locator ?? null,
      billing: input.byoc ? null : (input.billing ?? null),
      containment: getWorktreeCredentialContainment(),
      ...(input.sandboxKind ? { sandboxKind: input.sandboxKind } : {}),
      ...(policy.data.egressMode !== 'allowlist'
        ? {}
        : {
            egressAllowlist: buildNativeEgressAllowlist({
              allowlist: policy.data.egressAllowlist ?? [],
              env: this.env,
              repositoryUrl,
              kiloToken,
            }),
          }),
      ...(input.byoc ? { byoc: input.byoc } : {}),
      ...(policy.data.egressAudit === true ? { egressAudit: true } : {}),
    };
  }

  private async readLegacyCutover(): Promise<LegacyCutover> {
    const [kindRaw, configRaw, locatorRaw, allocationRaw, billingRaw] = await Promise.all([
      this.ctx.storage.get<unknown>('provider_kind'),
      this.ctx.storage.get<unknown>('provider_configuration'),
      this.ctx.storage.get<unknown>('provider_locator'),
      this.ctx.storage.get<unknown>('sandbox_allocation_state'),
      this.ctx.storage.get<unknown>('billing_input'),
    ]);
    // A fresh DO has no legacy state and starts on the current native runtime.
    // Any legacy storage keeps its historical default (cloudflare) so the
    // factory can refuse it instead of silently migrating the allocation.
    const hasLegacyStorage = [kindRaw, configRaw, locatorRaw, allocationRaw, billingRaw].some(
      value => value !== undefined
    );
    let provider: AgentSandboxProvider = hasLegacyStorage ? 'cloudflare' : 'cloudflare-containers';
    let configuration: SandboxProviderConfiguration | null = null;
    const parsedConfiguration = sandboxProviderConfigurationSchema.safeParse(configRaw);
    if (parsedConfiguration.success) {
      provider = parsedConfiguration.data.provider;
      configuration = parsedConfiguration.data;
    } else if (typeof kindRaw === 'string') {
      const kind = agentSandboxProviderSchema.safeParse(kindRaw);
      if (kind.success) provider = kind.data;
    }
    const locator = vercelProviderLocatorSchema.safeParse(locatorRaw);
    let providerRef: string | null = null;
    let allocationName: string | null = null;
    if (isRecord(allocationRaw)) {
      const state = allocationRaw.state;
      const target = isRecord(state) ? state.target : undefined;
      if (isRecord(target)) {
        if (typeof target.providerRef === 'string') providerRef = target.providerRef;
        if (typeof target.allocationName === 'string') allocationName = target.allocationName;
      }
    }
    return {
      provider,
      providerRef,
      allocationName,
      configuration,
      vercelLocator: locator.success ? locator.data : null,
      billing: (() => {
        if (billingRaw === undefined) return null;
        try {
          return parseSandboxBillingInput(billingRaw);
        } catch {
          return null;
        }
      })(),
    };
  }

  private async applyEvent(event: AllocationEvent): Promise<void> {
    const previous = await this.readAllocation();
    const timers = { ...this.sandboxTimers() };
    if (
      this.currentProvider() === 'cloudflare-containers' &&
      (event.type === 'ensure' || event.type === 'tick')
    ) {
      const routes = await listRoutes(this.db);
      const owner = workspaceSnapshotOwner(this.sandboxId, routes);
      const skip =
        owner === null
          ? 'no_routes'
          : workspaceSnapshotRestoreSkip(this.db, owner, routes, route =>
              this.workspaceSnapshotRouteEligible(route)
            );
      const workspaceTail =
        owner !== null &&
        (skip === undefined ||
          (skip === 'missing_descriptor' &&
            readWorkspaceSnapshotRaw(this.db, owner.workspaceId) !== undefined));
      // An environment that supplies build commands can only start from its
      // snapshot, so the lookup and restore get the repository startup budget.
      const environmentRequired = routes.some(
        route => route.state === 'preparing' && (route.spec.environmentSetupCommandCount ?? 0) > 0
      );
      if (workspaceTail || environmentRequired) {
        timers.providerCreateMs = DEADLINE_MS.repositoryStartup;
      }
    }
    const { state, effects, stopReason, routeFailure } = reduceAllocation(previous, event, timers);
    if (
      state.kind === 'creating' &&
      state.allocationId !== null &&
      state.allocationId !== previous.allocationId &&
      this.providerPin?.provider === 'vercel'
    ) {
      // Vercel retains stopped names. Pin a unique physical name before create,
      // so retries and reconstruction address this allocation's exact resource.
      const pin = {
        ...this.providerPin,
        allocationName: `sbx-${state.allocationId.replaceAll('-', '')}`,
      };
      await this.writeProviderPin(pin);
      this.providerPin = pin;
      this.provider = this.createProviderAdapter(pin);
    }
    await this.writeAllocation(state, previous);
    if (
      previous.kind !== state.kind ||
      previous.stopAttempt !== state.stopAttempt ||
      (previous.unconfirmedProviderRef === null) !== (state.unconfirmedProviderRef === null)
    ) {
      logControlDiagnostic('allocation_transition', {
        allocationName: this.providerPin?.allocationName ?? this.sandboxId,
        event: event.type,
        origin: event.type === 'socket-closed' ? event.origin : undefined,
        from: previous.kind,
        to: state.kind,
        fromAllocationId: previous.allocationId,
        toAllocationId: state.allocationId,
        stopAttempt: state.stopAttempt,
        stopReason: stopReason ?? 'none',
        routeFailure: routeFailure ?? 'none',
        unconfirmedProviderRef: state.unconfirmedProviderRef !== null,
      });
    }
    await this.armAlarm(state);
    // Fail the routes before the stopped sweep: a failed route has no attempt
    // time left, so nothing else retries a create that just spent its budget.
    if (routeFailure !== undefined) {
      await this.failPreparingRoutesNow(routeFailure);
    }
    await this.applyRouteEffects(previous, state, event, stopReason);
    for (const effect of effects) {
      await this.runEffect(effect, state);
    }
  }

  /**
   * Fails every preparing route with one reason, from inside the serialized
   * queue: the create attempt budget is spent, so the session DO must learn
   * that now, not at the routes' attempt deadline. Same mechanism as
   * `failCreationRoutes` for a permanent create failure.
   */
  private async failPreparingRoutesNow(reason: ControlPlaneFailureReason): Promise<void> {
    const state = await this.readAllocation();
    for (const route of await listRoutes(this.db)) {
      if (route.state === 'preparing') {
        await failCurrentAttempt(
          this.routeContext(state),
          route.sessionId,
          route.attemptId,
          reason,
          'create_exhausted'
        );
      }
    }
  }

  /**
   * One bound for a credential grant issuance (init and re-issue). A hung token
   * service must not hold this DO's serial queue for the preparation window; a
   * timeout is an issuance failure (`workspace_setup_failed`), not a hang. Reuses
   * the 30 s provider-stop bound, which already bounds provider policy work.
   */
  private grantIssueTimeoutMs(): number {
    return this.sandboxTimers().providerStopAttemptMs;
  }

  /** Bounds one member's scope backing renewal; the Session DO bounds the total. */
  private scopeBackingTokenMs(): number {
    return this.sandboxTimers().scopeBackingTokenMs;
  }

  /** Route transitions need storage, the bound socket and the bounded notify. */
  private routeContext(state: AllocationState): RouteContext {
    return {
      db: this.db,
      acceptedHandles: this.ctx.storage.kv,
      now: () => Date.now(),
      routePreparationMs: this.sandboxTimers().routePreparationMs,
      sendPrepare: route => this.sendSessionPrepare(state, route),
      notify: async (sessionId, update) => {
        this.notifications.enqueue(sessionId, {
          kind: 'route',
          payload: await this.withContainer(update, state),
        });
      },
      issueGrant: (spec, source, environment, diagnostic) =>
        withTimeout(
          this.issueRouteGrant(spec, source, environment, diagnostic),
          this.grantIssueTimeoutMs(),
          'Credential grant issuance timed out',
          diagnostic?.markTimeout
        ),
      applyPolicy: candidate =>
        candidate === undefined
          ? this.refreshVercelNetworkPolicy()
          : this.applyCandidateGrantPolicy(candidate),
      publishGrant: route => this.publishRouteGrant(route),
    };
  }

  private async runPrepare(
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource,
    sandboxSelection?: ControlPlaneSandboxSelection,
    environment?: SessionEnvironmentReference
  ): Promise<ControlPlaneRouteView> {
    // Sandbox owner admission (B3 review 5): the first prepare names the owner;
    // a later prepare for a different owner is rejected, not silently accepted.
    await this.initializeOwner(source.userId);
    let state = await this.readAllocation();
    if (state.kind === 'connected' || state.kind === 'disconnected')
      this.fenceWorkspaceSnapshot('preparation', spec.sessionId);
    if (
      (sandboxSelection?.provider ?? this.currentProvider()) === 'vercel' &&
      (sandboxSelection?.byoc ?? this.providerPin?.byoc) === undefined
    ) {
      return { state: 'failed', attemptId: crypto.randomUUID(), reason: 'byoc_credential_missing' };
    }
    // A worktree mid-deletion must never be re-prepared: a send in the Worker's
    // begin->finish window would otherwise start a fresh allocation and recreate
    // the checkout that deleteWorktreeResources just removed (spec §6, Shared
    // Worktrees rule 13). Return the failed view without persisting a route row:
    // a stale failed row would make a later exclusive deletion look shared. Any
    // row from an earlier prepare is removed so no route survives the worktree.
    const deletionJournal = await loadWorktreeDeletionJournal(
      this.ctx.storage,
      source.scopeId ?? spec.sessionId
    );
    if (deletionJournal !== undefined && !deletionJournal.completed) {
      this.notifications.retire(spec.sessionId);
      await deleteRoute(this.db, this.ctx.storage.kv, spec.sessionId);
      return {
        state: 'failed',
        attemptId: crypto.randomUUID(),
        reason: 'workspace_setup_failed',
      };
    }
    let selectedPin: StoredProviderPin | undefined;
    try {
      if (
        sandboxSelection !== undefined &&
        (state.kind === 'stopped' ||
          sandboxSelection.egressMode === 'allowlist' ||
          sandboxSelection.egressAudit === true ||
          this.providerPin?.egressAllowlist !== undefined ||
          this.providerPin?.egressAudit === true)
      ) {
        const repository = source.repository;
        selectedPin = this.pinFromInput(
          sandboxSelection,
          repository && repository.type !== 'github' ? repository.url : undefined,
          source.kiloToken
        );
      }
      if (
        state.kind !== 'stopped' &&
        (JSON.stringify(selectedPin?.egressAllowlist) !==
          JSON.stringify(this.providerPin?.egressAllowlist) ||
          (selectedPin?.egressAudit === true) !== (this.providerPin?.egressAudit === true))
      ) {
        throw new ProviderCreationError('invalid_configuration');
      }
    } catch (error) {
      if (!(error instanceof ProviderCreationError)) throw error;
      const attemptId = crypto.randomUUID();
      const route = await failRoute(
        this.routeContext(state),
        { ...spec, attemptId },
        attemptId,
        'invalid_configuration'
      );
      return routeView(route, state.kind === 'connected');
    }
    // H1: apply the Worker-selected provider pin before the first attempt. The
    // pin is only mutable while stopped; once an allocation exists its provider
    // is fixed and a repeated prepare must not re-decide it.
    if (selectedPin !== undefined && state.kind === 'stopped') {
      const pin = selectedPin;
      await this.writeProviderPin(pin);
      this.providerPin = pin;
      this.provider = this.createProviderAdapter(pin);
    }
    const { route, started } = await ensureRoute(
      this.routeContext(state),
      spec,
      source,
      environment ?? null
    );
    if (route.state !== 'failed') {
      if (started) await this.armAlarm(state);
      if (state.kind === 'stopped') {
        await this.applyEvent({
          type: 'ensure',
          at: Date.now(),
          allocationId: crypto.randomUUID(),
        });
        state = await this.readAllocation();
      }
    }
    return this.withContainer(
      routeView(route, state.kind === 'connected', sandboxPreparationProgress(state)),
      state
    );
  }

  private async withContainer<T extends ControlPlaneRouteUpdate>(
    view: T,
    state: AllocationState
  ): Promise<T> {
    if (view.state === 'unknown' || state.providerRef === null || state.allocationId === null) {
      return view;
    }
    try {
      const runtime = this.provider.describeRuntime?.(state.providerRef);
      if (runtime === undefined) return view;
      const launch = await readRepositoryLaunch(this.ctx.storage);
      const startSource =
        runtime.startSource ??
        (launch?.allocationId === state.allocationId && launch.startSource !== undefined
          ? launch.startSource === 'repository'
            ? 'snapshot'
            : 'image'
          : undefined);
      const container = CloudAgentRunContainerSchema.safeParse({
        ...runtime,
        allocationId: state.allocationId,
        ...(startSource === undefined ? {} : { startSource }),
        ...runtimeHarnessField(await this.allocationRuntimeHarness(state)),
      });
      return container.success ? { ...view, container: container.data } : view;
    } catch {
      logger
        .withFields({ sandboxId: this.sandboxId })
        .warn('Sandbox runtime metadata could not be projected; the route is unaffected');
      return view;
    }
  }

  /** Stores the sandbox owner on first use and rejects a different one. */
  private async initializeOwner(userId: string): Promise<void> {
    const normalized = userId.trim();
    if (normalized.length === 0) throw new Error('Sandbox owner is required');
    const stored = await this.ctx.storage.get<string>(OWNER_KEY);
    if (typeof stored === 'string' && stored.length > 0) {
      if (stored !== normalized) throw new Error('Sandbox owner mismatch');
      return;
    }
    await this.ctx.storage.put(OWNER_KEY, normalized);
  }

  private async requireOwner(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>(OWNER_KEY);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  }

  private async issueRouteGrant(
    spec: ControlPlaneRouteSpec,
    source: ControlPlaneCredentialSource,
    environment: SessionEnvironmentReference | null,
    diagnostic?: GrantDiagnostic
  ): Promise<RouteGrantIssue> {
    const provider = this.currentProvider();
    const allocation = await this.readAllocation();
    diagnostic?.fact({
      provider,
      containment: this.credentialContainmentEnabled() ? 'enabled' : 'disabled',
    });
    const runtimeContract = readRuntimeContract(this.ctx.storage.kv, allocation.allocationId);
    const base: SessionAttachPayload = {
      directory: spec.directory,
      ...(spec.branch ? { branch: spec.branch } : {}),
      ...(spec.branchMode ? { branchMode: spec.branchMode } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.setupCommands ? { setupCommands: spec.setupCommands } : {}),
      ...(spec.startCommands ? { startCommands: spec.startCommands } : {}),
      ...(spec.environmentSetupCommandCount === undefined
        ? {}
        : { environmentSetupCommandCount: spec.environmentSetupCommandCount }),
      ...(spec.runtimeIsolation ? { runtimeIsolation: spec.runtimeIsolation } : {}),
      ...(spec.git ? { git: spec.git } : {}),
    };
    const scopeId = source.scopeId ?? spec.sessionId;
    const scopes = listScopeGrants(this.db);
    const existing = scopes.find(
      grant => grant.scopeId === scopeId && hasRuntimeCredentialProxy(grant)
    );
    const outboundContainerId = this.outboundContainerIdFor() ?? undefined;
    if (
      runtimeContract !== 'legacy' &&
      !scopes.some(
        grant =>
          grant.scopeId === scopeId &&
          grant.members.some(member => member.sessionId === spec.sessionId)
      ) &&
      scopeMemberCount(scopes, scopeId) >= MAX_SCOPE_MEMBERS
    ) {
      diagnostic?.record({ grantPhase: 'compatibility', grantFailureReason: 'scope_member_limit' });
      throw new ScopeMemberLimitError();
    }
    const { grant, payload } = await prepareCredentialGrant(
      {
        env: this.env,
        source,
        sessionId: spec.sessionId,
        sandboxId: this.sandboxId,
        provider,
        containmentEnabled: this.credentialContainmentEnabled(),
        directory: spec.directory,
        scopeId,
        payload: base,
        leaseMs: this.sandboxTimers().credentialGrantMs,
        ...(environment ? { environment } : {}),
        ...(existing === undefined ? {} : { existing }),
        refreshBacking: existing !== undefined && this.grantNeedsReissue(existing),
        ...(outboundContainerId === undefined ? {} : { outboundContainerId }),
      },
      diagnostic
    );
    // A worktree scope may adopt one canonical handle only when it already has
    // an accepted entry under the current fence. Rows on this fence are written
    // in the same transaction as an accepted entry, so once ANY entry exists
    // (including an expired adoption marker) the incumbents are trusted even if
    // pruning has since dropped the exact string one row still holds. A scope
    // with stored rows but no accepted entry at all is the pre-deploy shape
    // (per-session handles this Sandbox never accepted): admitting a joiner
    // would let two different handles share one directory process after the
    // flip, so it is refused. The requesting member is excluded, so an
    // incumbent's own re-issue is never refused.
    if (runtimeContract !== 'legacy' && isWorkspaceProxyScope(grant)) {
      const incumbents = (grant.kilo.runtimeProxy?.members ?? []).filter(
        member =>
          member.sessionId !== spec.sessionId && member.kiloSessionId !== source.kiloSessionId
      );
      if (incumbents.length > 0) {
        const fence = this.runtimeProxyFenceFor(await this.readAllocation());
        if (fence !== null) {
          const accepted = await listAcceptedHandlesForScopeIncludingExpired(
            this.ctx.storage,
            scopeGrantId(grant),
            fence
          );
          if (accepted.length === 0) {
            diagnostic?.record({
              grantPhase: 'compatibility',
              grantFailureReason: 'scope_handle_conflict',
            });
            throw new ScopeHandleConflictError();
          }
        }
      }
    }
    for (const otherGrant of scopes) {
      if (scopeGrantId(otherGrant) === scopeGrantId(grant)) continue;
      if (
        runtimeContract === 'legacy' &&
        canShareLegacyRepositoryCredentials(otherGrant, grant, {
          sessionId: spec.sessionId,
          kiloSessionId: source.kiloSessionId,
        })
      )
        continue;
      // Shared runtimes hold one credential class per directory.
      if (
        runtimeContract !== 'legacy' &&
        otherGrant.directory === grant.directory &&
        (otherGrant.kilo.runtimeProxy !== undefined) !== (grant.kilo.runtimeProxy !== undefined)
      ) {
        diagnostic?.record({
          grantPhase: 'compatibility',
          grantFailureReason: 'mixed_credential_class',
        });
        throw new MixedCredentialClassError();
      }
      if (
        otherGrant.scopeId === scopeId ||
        otherGrant.directory === grant.directory ||
        otherGrant.members.some(
          member =>
            member.sessionId === spec.sessionId || member.kiloSessionId === source.kiloSessionId
        )
      ) {
        diagnostic?.record({ grantPhase: 'compatibility', grantFailureReason: 'scope_mismatch' });
        throw new Error('Worktree credential scope mismatch');
      }
    }
    return { grant, spec: this.projectRouteSpec(spec, payload) };
  }

  private publishRouteGrant(route: RouteRecord): void {
    this.db.transaction(tx => {
      if (route.grant !== null) writeScopeGrant(tx, route.grant);
      writeRoute(tx, route);
    });
  }

  private applyCandidateGrantPolicy(candidate: SessionCredentialGrant): Promise<boolean> {
    const now = Date.now();
    return this.refreshVercelNetworkPolicy([
      ...listScopeGrants(this.db).filter(
        grant =>
          hasRuntimeCredentialProxy(grant) &&
          scopeGrantId(grant) !== scopeGrantId(candidate) &&
          grant.expiresAt > now
      ),
      candidate,
    ]);
  }

  private projectRouteSpec(
    spec: ControlPlaneRouteSpec,
    payload: {
      directory?: string | undefined;
      env?: Record<string, string> | undefined;
      setupCommands?: string[] | undefined;
      startCommands?: string[] | undefined;
      environmentSetupCommandCount?: number | undefined;
      git?: SessionAttachPayload['git'];
      kilo: NonNullable<SessionAttachPayload['kilo']>;
      githubReviewTarget?: ControlPlaneRouteSpec['githubReviewTarget'];
    }
  ): ControlPlaneRouteSpec {
    // Explicit projection: token-bearing fields come only from the issued grant,
    // never from the input spec (B3 review 4). MCP plaintext is never projected
    // here; the Sandbox DO adds it only to a `session.prepare` frame.
    return {
      sessionId: spec.sessionId,
      kiloSessionId: spec.kiloSessionId,
      attemptId: spec.attemptId,
      directory: payload.directory ?? spec.directory,
      ...(spec.branch === undefined ? {} : { branch: spec.branch }),
      ...(spec.branchMode === undefined ? {} : { branchMode: spec.branchMode }),
      ...(spec.worktreeRecovery === undefined ? {} : { worktreeRecovery: spec.worktreeRecovery }),
      ...(spec.runtimeSkills === undefined ? {} : { runtimeSkills: spec.runtimeSkills }),
      ...(spec.runtimeAgents === undefined ? {} : { runtimeAgents: spec.runtimeAgents }),
      ...(spec.builtinAgents === undefined ? {} : { builtinAgents: spec.builtinAgents }),
      ...(spec.kiloCommands === undefined ? {} : { kiloCommands: spec.kiloCommands }),
      ...(spec.permission === undefined ? {} : { permission: spec.permission }),
      ...(spec.runtimeIsolation === undefined ? {} : { runtimeIsolation: spec.runtimeIsolation }),
      ...(payload.githubReviewTarget === undefined
        ? {}
        : { githubReviewTarget: payload.githubReviewTarget }),
      env: payload.env ?? {},
      ...(payload.setupCommands === undefined ? {} : { setupCommands: payload.setupCommands }),
      ...(payload.startCommands === undefined ? {} : { startCommands: payload.startCommands }),
      ...(payload.environmentSetupCommandCount === undefined
        ? {}
        : { environmentSetupCommandCount: payload.environmentSetupCommandCount }),
      ...(payload.git === undefined ? {} : { git: payload.git }),
      // The roots hold no credential; the wrapper takes each root's alias by host.
      ...(spec.roots === undefined ? {} : { roots: spec.roots }),
      kilo: payload.kilo,
    };
  }

  private async captureCommandFailureNote(
    sessionId: string,
    failures: readonly ControlPlaneCommandFailure[] | undefined
  ): Promise<void> {
    if (failures === undefined || failures.length === 0) return;
    const route = await readRoute(this.db, sessionId);
    if (route === null) return;
    const key = `${COMMAND_FAILURE_NOTE_KEY_PREFIX}${sessionId}`;
    const existing = await this.ctx.storage.get<PendingCommandFailureNote>(key);
    // Repeated `session.ready` for the same attempt must not duplicate the note.
    if (existing?.attemptId === route.attemptId) return;
    const note = commandFailureNote(failures);
    if (note.length === 0) return;
    await this.ctx.storage.put(key, {
      attemptId: route.attemptId,
      note,
    } satisfies PendingCommandFailureNote);
    for (const failure of failures) {
      logControlDiagnostic('command_failure_noted', {
        sandboxId: this.sandboxId,
        sessionId,
        kind: failure.kind,
        index: failure.index,
        exitCode: failure.exitCode,
        terminationReason: failure.terminationReason,
        elapsedMs: failure.elapsedMs,
      });
    }
  }

  private async pendingCommandFailureNote(
    sessionId: string,
    attemptId: string
  ): Promise<string | null> {
    const pending = await this.ctx.storage.get<PendingCommandFailureNote>(
      `${COMMAND_FAILURE_NOTE_KEY_PREFIX}${sessionId}`
    );
    return pending?.attemptId === attemptId ? pending.note : null;
  }

  private async consumeCommandFailureNote(sessionId: string, attemptId: string): Promise<void> {
    const key = `${COMMAND_FAILURE_NOTE_KEY_PREFIX}${sessionId}`;
    const pending = await this.ctx.storage.get<PendingCommandFailureNote>(key);
    if (pending?.attemptId !== attemptId) return;
    await this.ctx.storage.delete(key);
  }

  private async runDeliver(
    payload: ControlPlaneDeliverPayload
  ): Promise<ControlPlaneDeliverResult> {
    const state = await this.readAllocation();
    let route = await readRoute(this.db, payload.sessionId);
    if (state.kind !== 'connected' || route === null || route.state !== 'ready') {
      return 'not_ready';
    }
    if (payload.allocationId !== undefined && payload.allocationId !== state.allocationId) {
      return 'not_ready';
    }
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'not_ready';
    if (route.grant === null || !hasRuntimeCredentialProxy(route.grant)) {
      await onRouteFailed(
        this.routeContext(state),
        payload.sessionId,
        'credential_upgrade_required',
        undefined,
        true
      );
      return 'not_ready';
    }

    // Proactive maintenance runs whenever the shared canonical handle is within
    // the threshold, independent of the grant re-issue clock: it converges every
    // member row onto the canonical and hands off through a survivor before the
    // canonical ends. Only a worktree proxy scope has a canonical to maintain.
    // It runs before the re-issue so a rotated canonical is what the fresh grant
    // preserves.
    let adopted = false;
    if (route.grant !== null && isWorkspaceProxyScope(route.grant)) {
      const maintained = await this.maintainAdoptedScopeHandle(route.grant, state);
      route = { ...route, grant: maintained.grant };
      adopted = maintained.adopted;
    }

    // Credentials half of B3: a due grant is re-issued and `session.credentials`
    // is sent before the prompts. A failed re-issue still delivers on the
    // previous grant while it is valid.
    const renewed = await this.renewRouteGrant(route, state);
    if (renewed === null) return 'not_ready';
    route = renewed;

    // One verified-expiry check immediately before the prompts, for adopted
    // handles only. A per-session scope keeps its historical behavior: the
    // expired handle reaches Kilo and the upstream 401 surfaces it.
    if (
      adopted &&
      route.grant !== null &&
      (await this.routeRuntimeProxyExpired(route.grant, payload.sessionId))
    ) {
      await onRouteFailed(
        this.routeContext(state),
        payload.sessionId,
        'workspace_setup_failed',
        undefined,
        true
      );
      return 'not_ready';
    }

    // A ready route may have missed a fanout while its socket was down; resend
    // the current canonical before the prompt so it never runs on a superseded
    // handle.
    if (adopted) await this.ensureRouteCredentialsCurrent(payload.sessionId, state);

    let pendingNote = await this.pendingCommandFailureNote(payload.sessionId, route.attemptId);
    for (const message of payload.messages) {
      this.fenceWorkspaceSnapshot('prompt', payload.sessionId);
      const withNote =
        pendingNote === null ? null : promptWithCommandFailureNote(message, pendingNote);
      const sent = this.trySendFrame(socket, {
        type: 'session.prompt',
        sessionId: payload.sessionId,
        payload: withNote ?? message,
      });
      if (!sent) return 'not_ready';
      if (withNote !== null) {
        // Consume only after a prompt carrying the note was handed off.
        await this.consumeCommandFailureNote(payload.sessionId, route.attemptId);
        pendingNote = null;
      }
    }
    await this.touchActivity(Date.now());
    return 'sent';
  }

  private grantNeedsReissue(grant: SessionCredentialGrant): boolean {
    return grant.expiresAt - Date.now() < this.sandboxTimers().credentialGrantReissueBelowMs;
  }

  /**
   * Re-issues a ready route's grant once it is inside the re-issue window. Both
   * `deliver` and the alarm use this, so a long execution without new messages
   * renews its grant before the lease ends. A failed re-issue keeps the route
   * while its current grant is valid and lets the alarm retry later; once that
   * grant has expired there is no usable grant left, so the route fails now
   * with the real reason. Returns null when the route failed.
   */
  private async renewRouteGrant(
    route: RouteRecord,
    state: AllocationState
  ): Promise<RouteRecord | null> {
    if (route.grant === null || !this.grantNeedsReissue(route.grant)) return route;
    const { scopeId, expiresAt } = route.grant;
    const outcome = await this.reissueRouteGrant(route, state);
    if (outcome === 'issued') {
      this.credentialRenewalRetryAt.delete(scopeId);
    } else if (Date.now() >= expiresAt) {
      this.credentialRenewalRetryAt.delete(scopeId);
      await this.failUnrenewableRoute(route.sessionId, state);
      return null;
    } else {
      this.credentialRenewalRetryAt.set(
        scopeId,
        Date.now() + this.sandboxTimers().credentialGrantRenewalRetryMs
      );
    }
    return (await readRoute(this.db, route.sessionId)) ?? route;
  }

  /** The route's grant expired and could not be re-issued: fail with the real reason. */
  private async failUnrenewableRoute(sessionId: string, state: AllocationState): Promise<void> {
    await onRouteFailed(
      this.routeContext(state),
      sessionId,
      'workspace_setup_failed',
      undefined,
      true
    );
  }

  /**
   * The alarm half of credential renewal. Runs on the serial queue like
   * `deliver`, so it never races a sibling join or release. A shared worktree
   * scope is attempted once for all of its members: a success renews the shared
   * grant, a failure sets the scope's retry, and a failure at expiry fails the
   * other members without another attempt.
   */
  private async renewDueRouteGrants(state: AllocationState): Promise<void> {
    const routes = await listRoutes(this.db);
    const retries = this.credentialRenewalRetryAt;
    pruneCredentialRenewalRetries(retries, routes);
    const threshold = this.sandboxTimers().credentialGrantReissueBelowMs;
    const expiredScopes = new Set<string>();
    for (const listed of routes) {
      const dueAt = credentialRenewalDueAt(listed, threshold, retries);
      if (dueAt === null || dueAt > Date.now()) continue;
      const route = await readRoute(this.db, listed.sessionId);
      if (route?.state !== 'ready' || route.grant === null) continue;
      const { scopeId } = route.grant;
      if (expiredScopes.has(scopeId) && Date.now() >= route.grant.expiresAt) {
        await this.failUnrenewableRoute(route.sessionId, state);
      } else if ((await this.renewRouteGrant(route, state)) === null) {
        expiredScopes.add(scopeId);
      }
    }
  }

  /**
   * Re-issues a warm route's grant. The new grant is written only after the
   * provider policy that covers its aliases is applied, so a policy failure
   * leaves the previous grant in place. Any non-`issued` outcome means the
   * caller must not send `session.credentials`; `renewRouteGrant` keeps the
   * route while the previous grant is still due and fails it once that grant
   * has expired, so the Session DO starts a fresh attempt instead of waiting
   * for the backstop.
   */
  private async reissueRouteGrant(
    route: RouteRecord,
    state: AllocationState
  ): Promise<'issued' | 'policy_failed' | 'skipped' | 'failed'> {
    const source = route.credentialSource;
    if (source === null) return 'skipped';
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'skipped';
    let issued: RouteGrantIssue;
    try {
      // Bound the token-service round trip so a warm-route `deliver` cannot
      // hang forever; the grant-issue bound is the provider-stop bound.
      issued = await withTimeout(
        this.issueRouteGrant(route.spec, source, route.environment),
        this.grantIssueTimeoutMs(),
        'Credential grant re-issue timed out'
      );
    } catch {
      return 'failed';
    }
    const cloudAgentMcp = await this.tryIssueCloudAgentMcpGrant(route);
    if (!(await this.applyCandidateGrantPolicy(issued.grant))) return 'policy_failed';
    const next: RouteRecord = { ...route, grant: issued.grant, spec: issued.spec };
    this.publishRouteGrant(next);
    // Git/alias material is independent of the runtime-proxy handle, so a
    // re-issue still sends the frame even when the handle string did not change.
    // The canonical handoff runs separately in `runDeliver` maintenance.
    const payload = controlPlaneSessionCredentialsPayloadSchema.parse({
      ...sessionCredentialsPayloadFromGrant(issued.grant, route.sessionId),
      ...(cloudAgentMcp ? { cloudAgentMcp } : {}),
    });
    if (this.trySendFrame(socket, { type: 'session.credentials', ...payload })) {
      await this.markRouteCredentialsSent(route.sessionId, issued.grant);
    }
    return 'issued';
  }

  /**
   * Keeps a worktree scope's shared canonical handle healthy and every member
   * row converged on it. Convergence does not mint: when rows disagree it
   * rewrites them all to the current canonical and fans out, so a claim that
   * replaced the canonical on one row cannot strand another member. A canonical
   * within the threshold is handed off to an active member whose live delegation
   * outlives it; a canonical that has already ended is recovered through any
   * member whose delegation is still live. A failed mint, a full accepted set,
   * or no live member leaves the grant unchanged, and the caller fails only on
   * verified expiry. Never evicts an unexpired handle.
   *
   * The delegation reads, the mint and the policy update run on the serial
   * queue. Their count is bounded by the scope member cap, each read is bounded
   * by the grant-issue timeout, and no read or mint starts until the canonical is
   * within the threshold or has ended.
   */
  private async maintainAdoptedScopeHandle(
    grant: SessionCredentialGrant,
    state: AllocationState
  ): Promise<{ grant: SessionCredentialGrant; adopted: boolean }> {
    const proxy = grant.kilo.runtimeProxy;
    if (proxy === undefined || proxy.members.length === 0) return { grant, adopted: false };
    const fence = this.runtimeProxyFenceFor(state);
    if (fence === null || !(await this.isAdoptedScopeAtFence(grant, fence))) {
      return { grant, adopted: false };
    }
    const now = Date.now();
    const scopeKey = scopeGrantId(grant);
    const canonical = await this.selectCanonicalForScope(grant, fence, null);
    const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeKey, fence, now);

    if (canonical !== null && proxy.members.some(member => member.handle !== canonical.handle)) {
      // Only converge onto a canonical a current member can still serve; a
      // canonical whose issuer left the scope is left to the members that hold
      // it, as admission already decided for the requestor that could not.
      const converged = canonical.usable ? setAllMemberHandles(grant, canonical.handle) : grant;
      if (converged !== grant && (await this.applyCandidateGrantPolicy(converged))) {
        this.ctx.storage.transactionSync(() => writeScopeGrant(this.db, converged));
        await this.fanoutCanonicalCredentials(converged, state);
        this.logScopeHandleMaintenance(grant.scopeId, 'converged');
        return { grant: converged, adopted: true };
      }
    }

    const nearExpiry =
      canonical !== null &&
      canonical.exp - now < this.sandboxTimers().credentialGrantReissueBelowMs;
    if (canonical !== null && !nearExpiry) return { grant, adopted: true };

    const ownerId = await this.requireOwner();
    if (ownerId === null) return { grant, adopted: true };
    const canonicalIssuerSessionId = canonical?.issuerSessionId ?? null;
    const routes = await listRoutes(this.db);
    const members: HandoffMemberState[] = await Promise.all(
      proxy.members.map(async member => {
        const route = routes.find(candidate => candidate.sessionId === member.sessionId);
        const active = isActiveScopeMember(member, route, grant);
        let delegationExpiresAt: number | null = null;
        if (active) {
          const peer = this.sessionPeerFor(ownerId, member.sessionId);
          if (peer !== null) {
            try {
              delegationExpiresAt = await withTimeout(
                peer.getRuntimeProxyDelegationExpiresAt({
                  sandboxId: this.sandboxId,
                  directory: grant.directory,
                  kiloSessionId: member.kiloSessionId,
                }),
                this.scopeBackingTokenMs(),
                'Delegation expiry read timed out'
              );
            } catch {
              delegationExpiresAt = null;
            }
          }
        }
        return { ...member, delegationExpiresAt, active };
      })
    );
    const candidate = selectHandoffCandidate({
      canonicalExp: canonical === null ? now : canonical.exp,
      members,
    });
    if (candidate === null) {
      this.logScopeHandleMaintenance(
        grant.scopeId,
        canonical === null ? 'no_live_member' : 'no_extending_member'
      );
      return { grant, adopted: true };
    }
    // A same-issuer mint returns the same handle/exp, so never claim an
    // extension that did not happen. Recovery has no issuer to compare against.
    if (canonicalIssuerSessionId !== null && candidate.sessionId === canonicalIssuerSessionId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'not_needed');
      return { grant, adopted: true };
    }
    const peer = this.sessionPeerFor(ownerId, candidate.sessionId);
    if (peer === null) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const minted = await this.canonicalHandleMints.direct(peer, fence);
    if (minted === null || minted.exp <= now || minted.issuerSessionId !== candidate.sessionId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    if (canonical !== null && minted.exp <= canonical.exp) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const mintedClaims = await verifyRuntimeCredentialProxyHandle(this.env, minted.handle);
    if (mintedClaims === null || mintedClaims.userId !== ownerId) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }

    const updated = setAllMemberHandles(grant, minted.handle);
    const candidateDigest = await digestRuntimeProxyHandle(minted.handle);
    const alreadyAccepted = entries.some(entry =>
      constantTimeEqual(entry.handleDigest, candidateDigest)
    );
    // A same-fence mint through a member that already holds the handle returns
    // the same string, so the rows do not change; the handle must still be
    // accepted or the scope keeps looking adopted without a servable entry.
    if (updated === grant && alreadyAccepted) return { grant, adopted: true };
    if (!alreadyAccepted && entries.length >= ACCEPTED_HANDLES_MAX) {
      this.logScopeHandleMaintenance(grant.scopeId, 'set_full');
      return { grant, adopted: true };
    }
    if (updated !== grant && !(await this.applyCandidateGrantPolicy(updated))) {
      this.logScopeHandleMaintenance(grant.scopeId, 'mint_failed');
      return { grant, adopted: true };
    }
    const entry = {
      handleDigest: candidateDigest,
      handle: minted.handle,
      issuerSessionId: minted.issuerSessionId,
      scopeId: grant.scopeId,
      exp: minted.exp,
      fence,
    };
    let committed = true;
    this.ctx.storage.transactionSync(() => {
      const added = addAcceptedHandleSync(this.ctx.storage.kv, scopeKey, entry, now);
      if (added !== 'added' && added !== 'present') {
        committed = false;
        return;
      }
      if (updated !== grant) writeScopeGrant(this.db, updated);
    });
    if (!committed) {
      this.logScopeHandleMaintenance(grant.scopeId, 'set_full');
      return { grant, adopted: true };
    }
    await this.fanoutCanonicalCredentials(updated, state);
    this.logScopeHandleMaintenance(
      updated.scopeId,
      canonical === null ? 'expired_recovered' : 'rotated'
    );
    return { grant: updated, adopted: true };
  }

  private logScopeHandleMaintenance(
    scopeId: string,
    outcome:
      | 'converged'
      | 'not_needed'
      | 'no_extending_member'
      | 'no_live_member'
      | 'set_full'
      | 'mint_failed'
      | 'rotated'
      | 'expired_recovered'
  ): void {
    logger.withFields({ scopeId, outcome }).info('Control-plane scope handle maintenance');
  }

  /**
   * Sends the current canonical credentials to every ready or preparing member
   * of the scope whose last-sent handle differs. A preparing member is sent but
   * not marked delivered: it may be running an older wrapper that drops the
   * frame, and `session.ready` reconciles that. Frames whose handle is not the
   * current canonical are never sent.
   */
  private async fanoutCanonicalCredentials(
    grant: SessionCredentialGrant,
    state: AllocationState
  ): Promise<void> {
    if (grant.kilo.runtimeProxy === undefined) return;
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    const scopeKey = scopeGrantId(grant);
    for (const route of await listRoutes(this.db)) {
      if (route.state !== 'ready' && route.state !== 'preparing') continue;
      if (route.grant === null || scopeGrantId(route.grant) !== scopeKey) continue;
      const handle = memberHandleForSession(grant, route.sessionId);
      if (handle === null) continue;
      const digest = await digestRuntimeProxyHandle(handle);
      const lastSent = await readLastSentHandleDigest(this.ctx.storage, route.sessionId);
      if (lastSent !== null && constantTimeEqual(lastSent, digest)) continue;
      const sent = this.trySendFrame(socket, {
        type: 'session.credentials',
        ...sessionCredentialsPayloadFromGrant(grant, route.sessionId),
      });
      if (sent && route.state === 'ready') {
        await markLastSentHandle(this.ctx.storage, route.sessionId, digest);
      }
    }
  }

  /** Records the handle a `session.prepare`/`session.credentials` frame carried. */
  private async markRouteCredentialsSent(
    sessionId: string,
    grant: SessionCredentialGrant
  ): Promise<void> {
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return;
    await markLastSentHandle(this.ctx.storage, sessionId, await digestRuntimeProxyHandle(handle));
  }

  /**
   * Reconciliation for an adopted route: send the current canonical when the
   * route's last-sent marker no longer matches its row. It covers a preparing
   * route that missed a fanout (an older wrapper drops credentials frames before
   * it is prepared) and a ready route whose socket was down when a fanout was
   * attempted. A no-op when the strings already agree, so a normal prepare sends
   * nothing extra.
   */
  private async ensureRouteCredentialsCurrent(
    sessionId: string,
    state: AllocationState
  ): Promise<void> {
    const route = await readRoute(this.db, sessionId);
    const grant = route?.grant ?? null;
    if (route === null || grant === null) return;
    const fence = this.runtimeProxyFenceFor(state);
    if (!(await this.isAdoptedScopeAtFence(grant, fence))) return;
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return;
    const digest = await digestRuntimeProxyHandle(handle);
    const lastSent = await readLastSentHandleDigest(this.ctx.storage, sessionId);
    if (lastSent !== null && constantTimeEqual(lastSent, digest)) return;
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    if (
      this.trySendFrame(socket, {
        type: 'session.credentials',
        ...sessionCredentialsPayloadFromGrant(grant, sessionId),
      })
    ) {
      await markLastSentHandle(this.ctx.storage, sessionId, digest);
    }
  }

  /** Whether this route's runtime-proxy handle has verifiably expired. */
  private async routeRuntimeProxyExpired(
    grant: SessionCredentialGrant,
    sessionId: string
  ): Promise<boolean> {
    const handle = memberHandleForSession(grant, sessionId);
    if (handle === null) return false;
    const expiresAt = await verifyRuntimeCredentialProxyHandleExpiresAt(this.env, handle);
    return expiresAt !== null && expiresAt <= Date.now();
  }

  /**
   * The one owner of "is this scope adopted?": a worktree proxy scope with at
   * least one accepted entry under `fence`, including an expired-but-still-stored
   * entry (the adoption marker). Existing allocations retain per-session handles,
   * even when a newer wrapper reconnects or their last scope member leaves.
   */
  private async isAdoptedScopeAtFence(
    grant: SessionCredentialGrant,
    fence: ControlRuntimeCredentialProxyFence | null
  ): Promise<boolean> {
    if (
      fence === null ||
      readRuntimeContract(this.ctx.storage.kv, fence.allocationId) !== 'worktree'
    )
      return false;
    const marker = await hasAcceptedScopeHandle(this.ctx.storage, scopeGrantId(grant), fence);
    return isAdoptableWorktreeScope({ grant, acceptedMarker: marker });
  }

  /** The managed outbound container id for the current provider/allocation. */
  private outboundContainerIdFor(): string | null {
    // The container is the containment boundary. When containment is off there
    // is no proxy container to name, and the environment may not even bind the
    // containment namespaces (the e2e Worker strips them).
    if (!this.credentialContainmentEnabled()) return null;
    const provider = this.currentProvider();
    if (provider === 'cloudflare') return null;
    if (provider === 'vercel') return this.sandboxId;
    if (!providerUsesOutboundCredentialProxy(provider)) return null;
    return (
      getManagedOutboundContainerId(provider, this.env, {
        logicalSandboxId: this.sandboxId,
        physicalSandboxId: this.sandboxId,
      }) ?? null
    );
  }

  /** Saved requirements remain authoritative until the old allocation stops. */
  private credentialContainmentEnabled(): boolean {
    const containment = this.resolvedContainment();
    return containment.kilocode || containment.github;
  }

  /**
   * The one resolved containment requirement for this sandbox: the
   * Worker-selected per-requirement value, else the environment default. Every
   * consumer (grants and the provider create intent) reads this, so the physical
   * container class and the grant can never disagree.
   */
  private resolvedContainment(): CredentialContainmentRequirements {
    return this.providerPin?.containment ?? getWorktreeCredentialContainment();
  }

  private matchesContainment(required: CredentialContainmentRequirements): boolean {
    const stored = this.resolvedContainment();
    return (
      stored.kilocode === required.kilocode &&
      stored.github === required.github &&
      stored.worktreeScoped === (required.worktreeScoped ?? true)
    );
  }

  private async activeGrants(now: number): Promise<SessionCredentialGrant[]> {
    return listScopeGrants(this.db).filter(
      grant => hasRuntimeCredentialProxy(grant) && grant.expiresAt > now
    );
  }

  /**
   * Rebuilds the Vercel network policy from the stored grants (or a caller's
   * candidate set) through the provider's contained-credential hook. Runs inside
   * the operation queue and does not stop the sandbox: it returns `false` on
   * failure so callers can decide (retry vs. fail closed). Transient failures
   * keep the route alive so a later send can retry (N2). A live Vercel sandbox
   * whose adapter lacks the hook cannot apply the policy, so it fails closed
   * exactly like a throwing hook.
   */
  private async refreshVercelNetworkPolicy(
    grantsOverride?: readonly SessionCredentialGrant[]
  ): Promise<boolean> {
    if (this.currentProvider() !== 'vercel') return true;
    try {
      const state = await this.readAllocation();
      const providerRef = state.providerRef;
      const provider = this.provider;
      if (state.kind === 'stopping' || state.kind === 'stopped') return true;
      if (providerRef === null) return true;
      if (!provider.applyContainedCredentials) return false;
      const grants = grantsOverride ?? (await this.activeGrants(Date.now()));
      await withTimeout(
        provider.applyContainedCredentials(providerRef, grants),
        this.sandboxTimers().providerStopAttemptMs,
        'Sandbox network policy update timed out'
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fail-closed revocation path: if the released session's alias cannot be
   * removed from the provider policy, stop the sandbox as a platform failure.
   */
  private async applyVercelNetworkPolicyOrStop(reason: ControlPlaneFailureReason): Promise<void> {
    if (await this.refreshVercelNetworkPolicy()) return;
    const state = await this.readAllocation();
    if (state.kind === 'stopped' || state.kind === 'stopping') return;
    await this.applyEvent({ type: 'stop-requested', at: Date.now(), reason });
  }

  private async dispatchToWrapper(
    frame: ControlPlaneWrapperFrame
  ): Promise<ControlPlaneDispatchResult> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return 'not_connected';
    this.fenceWorkspaceSnapshot(
      frame.type === 'session.answer' ? 'answer' : 'abort',
      'sessionId' in frame ? frame.sessionId : undefined
    );
    if (frame.type === 'session.answer') await this.touchActivity(Date.now());
    return this.trySendFrame(socket, frame) ? 'sent' : 'not_connected';
  }

  /**
   * Delivery is sandbox activity (spec §6 "Activity"): move the idle clock and
   * re-arm the alarm. The allocation reducer still owns every transition; this
   * only refreshes the activity data it reads.
   */
  private async touchActivity(at: number): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'connected') return;
    const next: AllocationState = { ...state, lastActivityAt: at };
    await this.writeAllocation(next, state);
    await this.armAlarm(next);
  }

  private async applyRouteEffects(
    previous: AllocationState,
    next: AllocationState,
    event: AllocationEvent,
    stopReason: ControlPlaneFailureReason | undefined
  ): Promise<void> {
    if (previous.allocationId !== null && previous.allocationId !== next.allocationId) {
      this.db.transaction(tx => retireScopeGrants(tx, this.ctx.storage.kv));
    }
    // Until the wrapper connects, the allocation is the preparation progress:
    // show creating, retrying and starting rather than one silent step.
    if (
      (next.kind === 'creating' || next.kind === 'starting' || next.kind === 'stopping') &&
      (previous.kind !== next.kind || previous.allocationId !== next.allocationId)
    ) {
      const progress = sandboxPreparationProgress(next);
      if (progress !== undefined) {
        await notifyPreparingRoutes(
          this.routeContext(next),
          previous.kind === 'creating' && next.kind === 'creating'
            ? { ...progress, detail: 'Retrying sandbox creation' }
            : progress
        );
      }
    }
    if (event.type === 'hello-accepted' && next.kind === 'connected') {
      const restarted = previous.wrapperId !== null && previous.wrapperId !== next.wrapperId;
      if (restarted) {
        // A new wrapper instance supersedes the previous fence's accepted
        // handles and every member's stored handle string. Retire both before
        // the bind/adoption scan so a handle minted for the new fence during the
        // scan is not deleted by this.
        this.ctx.storage.transactionSync(() => {
          retireAcceptedHandlesSync(this.ctx.storage.kv);
          for (const grant of listScopeGrants(this.db)) {
            const cleared = clearRuntimeProxyMembers(grant);
            if (cleared !== grant) writeScopeGrant(this.db, cleared);
          }
        });
      }
      for (const route of await listRoutes(this.db)) {
        if (route.state !== 'preparing' || route.grant !== null) continue;
        if (route.credentialSource === null) continue;
        try {
          const issued = await withTimeout(
            this.issueRouteGrant(route.spec, route.credentialSource, route.environment),
            this.grantIssueTimeoutMs(),
            'Credential binding timed out'
          );
          if (!(await this.applyCandidateGrantPolicy(issued.grant)))
            throw new Error('Credential policy unavailable');
          this.publishRouteGrant({ ...route, ...issued });
        } catch (error) {
          const failure = grantIssueFailure(error, 'runtime_proxy_bind_failed');
          await failCurrentAttempt(
            this.routeContext(next),
            route.sessionId,
            route.attemptId,
            failure.reason,
            failure.stage
          );
        }
      }
      await onWrapperConnected(this.routeContext(next), restarted);
      return;
    }
    if (previous.kind === 'connected' && next.kind === 'disconnected') {
      await notifyReadyRoutes(this.routeContext(next));
      return;
    }
    if (
      event.type === 'startup-failed' &&
      previous.kind !== 'stopping' &&
      next.kind === 'stopping'
    ) {
      const reason = STARTUP_FAILURES[event.code].reason;
      if (reason !== null) {
        for (const route of await listRoutes(this.db)) {
          if (route.state === 'preparing')
            await failCurrentAttempt(
              this.routeContext(next),
              route.sessionId,
              route.attemptId,
              reason,
              'runtime_startup_failed'
            );
        }
      }
    }
    if (previous.kind !== 'stopping' && next.kind === 'stopping') {
      // The reducer owns the cause; ready routes must not re-derive it.
      if (stopReason !== undefined) {
        await dropReadyRoutes(this.routeContext(next), stopReason);
        // The sandbox is already stopping; refresh best-effort.
        await this.refreshVercelNetworkPolicy();
      }
      return;
    }
    if (previous.kind !== 'stopped' && next.kind === 'stopped') {
      await this.onAllocationStopped(previous, next);
    }
  }

  private async onAllocationStopped(
    previous: AllocationState,
    next: AllocationState
  ): Promise<void> {
    const pin = this.providerPin;
    if (pin?.containment && (!pin.containment.kilocode || !pin.containment.github)) {
      const upgraded = { ...pin, containment: getWorktreeCredentialContainment() };
      await this.writeProviderPin(upgraded);
      this.providerPin = upgraded;
      this.provider = this.createProviderAdapter(upgraded);
    }
    const ctx = this.routeContext(next);
    this.db.transaction(tx => retireScopeGrants(tx, this.ctx.storage.kv));
    // `create-failed` with no retry, a confirmed stop and `provider-gone` can
    // all reach `stopped` without arming an alarm, so sweep expired routes now.
    await failExpiredRoutes(ctx);
    if (previous.kind !== 'stopping') {
      // A direct `provider-gone` keeps ready routes; they lose the sandbox.
      await dropReadyRoutes(ctx, 'sandbox_lost');
    }
    // A preparing route with attempt time left keeps its deadline across the
    // reallocation (spec §6).
    const retry = await routeRetryAllowed(ctx);
    const routes = await listRoutes(this.db);
    logControlDiagnostic('allocation_stopped', {
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      from: previous.kind,
      unconfirmedProviderRef: next.unconfirmedProviderRef !== null,
      reallocate: retry,
      preparingRoutes: routes.filter(route => route.state === 'preparing').length,
      readyRoutes: routes.filter(route => route.state === 'ready').length,
      otherRoutes: routes.filter(route => route.state !== 'preparing' && route.state !== 'ready')
        .length,
    });
    if (retry && !this.createInFlight) {
      await this.applyEvent({ type: 'ensure', at: ctx.now(), allocationId: crypto.randomUUID() });
    } else {
      await this.armAlarm(next);
    }
  }

  private forwardEvents(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'session.events' }>,
    current: boolean
  ): void {
    if (!current) return;
    this.notifications.enqueue(frame.sessionId, {
      kind: 'events',
      payload: { events: frame.events },
    });
  }

  private fenceWorkspaceSnapshot(reason = 'mutation', sessionId?: string): void {
    fenceWorkspaceSnapshot(this.db, reason, sessionId);
  }

  private forwardOutcome(
    frame: Extract<ControlPlaneWrapperFrame, { type: 'session.outcome' }>,
    current: boolean
  ): void {
    if (!current) return;
    const { type: _type, ...outcome } = frame;
    this.notifications.enqueue(outcome.sessionId, { kind: 'outcome', payload: outcome });
  }

  /**
   * Decrypts the DO-private credential-source `mcpServers` snapshot immediately
   * before an authenticated `session.prepare` frame. The plaintext never touches
   * a persisted route row. A missing key, invalid envelope or over-limit payload
   * throws so the fenced attempt fails fast (`workspace_setup_failed`) instead of
   * sending a frame the wrapper would drop while the route waits out its
   * preparation timeout.
   */
  private materializeRouteMcp(route: RouteRecord): ControlPlaneRouteSpec['mcp'] {
    const encrypted = route.credentialSource?.mcpServers;
    if (encrypted === undefined || Object.keys(encrypted).length === 0) return undefined;
    const servers = z.record(z.string().min(1).max(100), MCPServerConfigSchema).parse(encrypted);
    let materialized: Record<string, CliMcpServer>;
    try {
      materialized = materializeMcpServers(servers, this.env.AGENT_ENV_VARS_PRIVATE_KEY);
    } catch (error) {
      if (error instanceof McpConfigurationError) {
        throw new McpAttachValidationError(
          mcpValidationMessage(mcpConfigurationFailureReason(error))
        );
      }
      throw error;
    }
    const validated = parseSessionAttachMcpServers(materialized);
    if (!validated.success) throw new McpAttachValidationError(validated.reason);
    return validated.data;
  }

  private sendSessionPrepare(state: AllocationState, route: RouteRecord): void {
    if (snapshotRestorePending(this.db, state.allocationId)) return;
    if (state.allocationId !== null && this.launchInFlightAllocationId === state.allocationId)
      return;
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    // A route without a grant never reaches `preparing` (issuance failure marks
    // it `failed`), so never send a spec that could carry raw issuer material.
    if (route.grant === null) return;
    if (!hasRuntimeCredentialProxy(route.grant)) {
      this.ctx.waitUntil(
        this.failPrepareAttempt(
          route.sessionId,
          route.attemptId,
          'credential_upgrade_required',
          'credential_upgrade_required'
        ).catch(() => {
          logger
            .withFields({
              sandboxId: this.sandboxId,
              sessionId: route.sessionId,
              attemptId: route.attemptId,
            })
            .warn('Could not persist credential upgrade failure');
        })
      );
      return;
    }
    // Minting calls the Session DO and must stay outside this serial queue.
    this.ctx.waitUntil(this.sendSessionPrepareWithRuntimeProxy(route.sessionId, route.attemptId));
  }

  /** Whether the bound wrapper advertised that it redacts named secret keys. */
  private wrapperRedactsNamedSecrets(socket: WebSocket): boolean {
    return this.readAttachment(socket)?.redactsNamedSecrets === true;
  }

  private wrapperInstallsSkillsSh(socket: WebSocket): boolean {
    return this.readAttachment(socket)?.installsSkillsSh === true;
  }

  private wrapperAcceptsWorkspaceConfiguration(socket: WebSocket): boolean {
    return this.readAttachment(socket)?.workspaceConfiguration === true;
  }

  /**
   * A failure throws rather than sending a frame the wrapper would drop while the
   * route waits out its preparation deadline.
   */
  private materializePrepareFrame(route: RouteRecord, socket: WebSocket): MaterializedPrepareFrame {
    if (
      route.spec.runtimeSkills?.some(skill => 'source' in skill) &&
      !this.wrapperInstallsSkillsSh(socket)
    ) {
      throw new PrepareFrameMaterializationError('wrapper_skills_sh_unsupported');
    }
    const attachment = this.readAttachment(socket);
    const snapshotFrame = workspaceSnapshotFrame(this.db, route, attachment);
    const wireSpec: ControlPlaneRouteSpec = {
      ...runtimeSpecForContract(
        route.spec,
        readRuntimeContract(this.ctx.storage.kv, attachment?.allocationId ?? null)
      ),
      ...snapshotFrame,
    };
    // A restored workspace tail runs no commands, so the frame carries none. A
    // non-tail start sends the environment build boundary and start list.
    if (snapshotFrame.workspaceSnapshot !== undefined) {
      delete wireSpec.setupCommands;
      delete wireSpec.startCommands;
      delete wireSpec.environmentSetupCommandCount;
    }
    const encryptedSecrets = route.credentialSource?.encryptedSecrets;
    try {
      const frameEnv = buildFrameEnv({
        specEnv: route.spec.env,
        encryptedSecrets,
        privateKey: this.env.AGENT_ENV_VARS_PRIVATE_KEY,
      });
      // Fail closed only when a secret value would actually reach the frame and
      // the wrapper cannot redact it by name; a snapshot whose keys are all
      // restored or dropped sends nothing and needs no redaction.
      if (frameEnv.secretEnvKeys.length > 0 && !this.wrapperRedactsNamedSecrets(socket)) {
        throw new PrepareFrameMaterializationError('wrapper_redaction_unsupported');
      }
      if (frameEnv.secretEnvKeys.length > 0) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            sessionId: route.sessionId,
            secretCount: frameEnv.secretEnvKeys.length,
          })
          .info('Materialized session.prepare secrets');
      }
      const frameSpec = controlPlaneRouteSpecSchema.parse({
        ...wireSpec,
        createdOnPlatform: route.credentialSource?.createdOnPlatform,
        ...(frameEnv.env === undefined ? {} : { env: frameEnv.env }),
        ...(frameEnv.secretEnvKeys.length === 0 ? {} : { secretEnvKeys: frameEnv.secretEnvKeys }),
      });
      if (!this.wrapperAcceptsWorkspaceConfiguration(socket)) {
        const mcp = this.materializeRouteMcp(route);
        return {
          type: 'session.prepare',
          spec: controlPlaneRouteSpecSchema.parse({
            ...frameSpec,
            ...(mcp === undefined ? {} : { mcp }),
          }),
        };
      }

      return {
        type: 'session.attach',
        spec: attachmentSpecFromRouteSpec(frameSpec),
        workspace: workspaceConfigFromSpec(frameSpec, this.materializeRouteMcp(route)),
      };
    } catch (error) {
      if (error instanceof PrepareFrameMaterializationError) throw error;
      // Preserve the sanitized, bounded MCP reason for diagnosis.
      if (error instanceof McpAttachValidationError) {
        logger
          .withFields({
            sandboxId: this.sandboxId,
            sessionId: route.sessionId,
            reason: error.reason,
          })
          .warn('MCP materialization failed before session.prepare');
      }
      throw new PrepareFrameMaterializationError(
        'frame_materialization_failed',
        errorClassName(error)
      );
    }
  }

  /** One sanitized failure line: stage, error class and secret count only. */
  private logPrepareFrameMaterializationFailure(route: RouteRecord, error: unknown): void {
    const encrypted = route.credentialSource?.encryptedSecrets;
    logger
      .withFields({
        sandboxId: this.sandboxId,
        sessionId: route.sessionId,
        attemptId: route.attemptId,
        stage: materializationStage(error),
        secretCount: encrypted === undefined ? 0 : Object.keys(encrypted).length,
        errorClass:
          error instanceof PrepareFrameMaterializationError
            ? (error.sourceErrorName ?? error.name)
            : errorClassName(error),
      })
      .warn('session.prepare frame materialization failed');
  }

  private prepareCredentials(
    grant: SessionCredentialGrant,
    sessionId: string
  ): ControlPlaneSessionCredentialsPayload {
    return controlPlaneSessionCredentialsPayloadSchema.parse(
      sessionCredentialsPayloadFromGrant(grant, sessionId)
    );
  }

  /**
   * Runtime credential proxy: mint the handle through the Session DO (bounded by
   * the grant bound, fence passed in), bind it for Vercel, then send
   * `session.prepare`. Runs off the serial queue; a mint or bind failure fails
   * the fenced attempt as `workspace_setup_failed`. An adopted worktree scope
   * routes through the canonical-handle path instead.
   */
  private async sendSessionPrepareWithRuntimeProxy(
    sessionId: string,
    attemptId: string
  ): Promise<void> {
    try {
      const route = await readRoute(this.db, sessionId);
      if (!isCurrentPreparingAttempt(route, attemptId)) return;
      if (route.grant === null || route.grant.kilo.runtimeProxy === undefined) return;
      // One owner per sandbox (B3 review 5), stored on first prepare/registration;
      // the Session DO name is `ownerId:sessionId`.
      const ownerId = await this.requireOwner();
      const peer = ownerId === null ? null : this.sessionPeerFor(ownerId, sessionId);
      const fence = this.runtimeProxyFenceFor(await this.readAllocation());

      if (fence !== null && (await this.isAdoptedScopeAtFence(route.grant, fence))) {
        const outcome = await this.sendSessionPrepareWithAdoptedScope({
          route,
          sessionId,
          attemptId,
          ownerId,
          peer,
          fence,
        });
        if (outcome === 'done') return;
      }

      await this.sendSessionPrepareWithPerSessionHandle({
        route,
        sessionId,
        attemptId,
        ownerId,
        peer,
        fence,
      });
    } catch {
      // A throw here (read/parse/bind) must still fail the fenced attempt; the
      // failure path is itself guarded so it cannot escape this off-queue task.
      try {
        await this.failPrepareAttempt(sessionId, attemptId);
      } catch {
        // Best effort only.
      }
    }
  }

  /**
   * The per-session path: mint through the requesting member, bind when the
   * stored handle is stale, then send. Used for legacy grants, non-worktree
   * scopes, migration scopes, and an adopted scope the claim re-check rejects.
   */
  private async sendSessionPrepareWithPerSessionHandle(input: {
    route: RouteRecord;
    sessionId: string;
    attemptId: string;
    ownerId: string | null;
    peer: ControlPlaneSessionPeer | null;
    fence: ControlRuntimeCredentialProxyFence | null;
  }): Promise<void> {
    const { sessionId, attemptId, ownerId, peer, fence } = input;
    let route = input.route;
    const member = route.grant?.kilo.runtimeProxy?.members.find(
      candidate => candidate.sessionId === sessionId
    );
    // The fence the handle in the frame belongs to; null when we send an
    // already-bound member without a fresh mint.
    let mintedFence: ControlRuntimeCredentialProxyFence | null = null;

    if (fence === null || ownerId === null || peer === null) {
      // No allocation to mint against (or no Session peer): an existing member
      // is the only handle we have; without one the preparation cannot proceed.
      if (member === undefined) {
        await this.failPrepareAttempt(sessionId, attemptId);
        return;
      }
    } else {
      // Fence-keyed and idempotent: the same allocation/wrapper returns the same
      // persisted grant, a restart or reallocation returns a new one.
      const handle = await this.mintRuntimeProxyGrant(peer, fence);
      if (handle === null) {
        await this.failPrepareAttempt(sessionId, attemptId);
        return;
      }
      // A wrapper restart or reallocation during the mint means another task
      // owns the current fence; drop out without failing the attempt it is
      // preparing.
      const afterMint = this.runtimeProxyFenceFor(await this.readAllocation());
      if (afterMint === null || !sameRuntimeProxyControlBinding(fence, afterMint)) return;
      // A member minted under the current fence is already bound; a member from
      // a superseded fence (wrapper restart or reallocation while the route is
      // still preparing) must be replaced, or the wrapper receives a stale
      // handle the proxy cannot resolve.
      if (
        member === undefined ||
        runtimeProxyHandleGrantId(member.handle) !== runtimeProxyHandleGrantId(handle)
      ) {
        try {
          await this.bindRuntimeCredentialProxyHandle({
            ownerId,
            sessionId,
            kiloSessionId: route.spec.kiloSessionId,
            directory: route.spec.directory,
            handle,
          });
        } catch {
          await this.failPrepareAttempt(sessionId, attemptId);
          return;
        }
        // A restart during the bind supersedes this task too: do not send.
        const afterBind = this.runtimeProxyFenceFor(await this.readAllocation());
        if (afterBind === null || !sameRuntimeProxyControlBinding(fence, afterBind)) return;
        const refreshed = await readRoute(this.db, sessionId);
        if (!isCurrentPreparingAttempt(refreshed, attemptId)) return;
        if (refreshed.grant === null || refreshed.grant.kilo.runtimeProxy === undefined) return;
        route = refreshed;
      }
      mintedFence = fence;
    }

    await this.sendPreparedRouteFrame(sessionId, attemptId, mintedFence);
  }

  /**
   * Canonical adoption: one accepted handle per worktree scope. The first
   * prepare mints through its requesting member (single-flight so concurrent
   * preparers share one mint); a joiner copies the canonical string; a candidate
   * only replaces a canonical when it can be served and expires later. The mint
   * stays off the serial queue; claim/adopt runs on it. Returns `per-session`
   * when the scope must fall back to the legacy path.
   */
  private async sendSessionPrepareWithAdoptedScope(input: {
    route: RouteRecord;
    sessionId: string;
    attemptId: string;
    ownerId: string | null;
    peer: ControlPlaneSessionPeer | null;
    fence: ControlRuntimeCredentialProxyFence | null;
  }): Promise<'done' | 'per-session'> {
    const { route, sessionId, attemptId, ownerId, peer, fence } = input;
    const grant = route.grant;
    if (grant === null || grant.kilo.runtimeProxy === undefined) return 'done';
    if (fence === null || ownerId === null || peer === null) return 'per-session';
    const now = Date.now();
    const threshold = this.sandboxTimers().credentialGrantReissueBelowMs;
    const canonical = await this.selectCanonicalForScope(grant, fence, sessionId);
    const needsMint = canonical === null || !canonical.usable || canonical.exp - now < threshold;
    const mintKey = canonicalMintKey(scopeGrantId(grant), fence);
    let candidate = needsMint ? await this.canonicalHandleMints.shared(mintKey, peer, fence) : null;
    if (needsMint && candidate === null) {
      candidate = await this.canonicalHandleMints.direct(peer, fence);
    }
    let claim = await this.claimAdoptedScopeHandle({
      sessionId,
      attemptId,
      ownerId,
      kiloSessionId: route.spec.kiloSessionId,
      candidate,
      mintFence: fence,
    });
    if (claim.kind === 'per-session') return 'per-session';
    if (claim.kind === 'remint') {
      const own = await this.canonicalHandleMints.direct(peer, fence);
      claim = await this.claimAdoptedScopeHandle({
        sessionId,
        attemptId,
        ownerId,
        kiloSessionId: route.spec.kiloSessionId,
        candidate: own,
        mintFence: fence,
      });
      if (claim.kind === 'per-session') return 'per-session';
      // A remint that still cannot mint leaves no handle to serve.
      if (claim.kind === 'remint') claim = { kind: 'fail' };
    }
    if (claim.kind === 'stale') return 'done';
    if (claim.kind === 'fail') {
      await this.failPrepareAttempt(sessionId, attemptId);
      return 'done';
    }
    await this.sendPreparedRouteFrame(sessionId, attemptId, fence);
    return 'done';
  }

  /**
   * Sends `session.prepare` for a preparing route, re-reading the route and the
   * allocation from one read so a restart between adoption and send cannot
   * deliver a stale handle.
   */
  private async sendPreparedRouteFrame(
    sessionId: string,
    attemptId: string,
    expectedFence: ControlRuntimeCredentialProxyFence | null
  ): Promise<void> {
    const state = await this.readAllocation();
    const socket = this.boundWrapperSocket(state);
    if (socket === null) return;
    if (snapshotRestorePending(this.db, state.allocationId)) return;
    const latest = await readRoute(this.db, sessionId);
    if (!isCurrentPreparingAttempt(latest, attemptId)) return;
    if (latest.grant === null || latest.grant.kilo.runtimeProxy === undefined) return;
    if (expectedFence !== null) {
      const sendFence = this.runtimeProxyFenceFor(state);
      if (sendFence === null || !sameRuntimeProxyControlBinding(expectedFence, sendFence)) return;
    }
    const cloudAgentMcp = await this.tryIssueCloudAgentMcpGrant(latest);
    let frame: MaterializedPrepareFrame;
    try {
      frame = this.materializePrepareFrame(latest, socket);
    } catch (error) {
      this.logPrepareFrameMaterializationFailure(latest, error);
      await this.failPrepareAttempt(sessionId, attemptId, materializationStage(error));
      return;
    }

    const sendState = await this.readAllocation();
    if (this.boundWrapperSocket(sendState) !== socket) return;
    const sendRoute = await readRoute(this.db, sessionId);
    if (!isCurrentPreparingAttempt(sendRoute, attemptId)) return;
    if (sendRoute.grant === null || sendRoute.grant.kilo.runtimeProxy === undefined) return;
    if (expectedFence !== null) {
      const sendFence = this.runtimeProxyFenceFor(sendState);
      if (sendFence === null || !sameRuntimeProxyControlBinding(expectedFence, sendFence)) return;
    }

    const credentials = controlPlaneSessionCredentialsPayloadSchema.parse({
      ...this.prepareCredentials(sendRoute.grant, sessionId),
      ...(cloudAgentMcp ? { cloudAgentMcp } : {}),
    });
    const sent = this.trySendFrame(socket, { ...frame, credentials });
    if (sent) await this.markRouteCredentialsSent(sessionId, sendRoute.grant);
  }

  /**
   * Claims and commits the handle for one preparing route on the serial queue.
   * Every authorization and policy check runs before the accepted entry and the
   * requesting member's row commit together in one `transactionSync`, so a
   * failed check leaves no orphan. Returns `per-session` when the scope must
   * fall back, `remint` when a shared mint cannot bind for this requestor.
   */
  private claimAdoptedScopeHandle(input: {
    sessionId: string;
    attemptId: string;
    ownerId: string;
    kiloSessionId: string;
    candidate: CanonicalHandleMint | null;
    mintFence: ControlRuntimeCredentialProxyFence;
  }): Promise<ScopeHandleClaim> {
    return this.enqueue(async () => {
      const route = await readRoute(this.db, input.sessionId);
      if (!isCurrentPreparingAttempt(route, input.attemptId)) return { kind: 'stale' };
      const grant = route.grant;
      if (grant === null || grant.kilo.runtimeProxy === undefined) return { kind: 'stale' };
      const allocation = await this.readAllocation();
      const fence = this.runtimeProxyFenceFor(allocation);
      if (fence === null) return { kind: 'stale' };
      const scopeKey = scopeGrantId(grant);
      const now = Date.now();
      if (grant.expiresAt <= now) return { kind: 'fail' };

      const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeKey, fence, now);
      const acceptedDigests = new Set(entries.map(entry => entry.handleDigest));
      const marker = await hasAcceptedScopeHandle(this.ctx.storage, scopeKey, fence);
      if (
        readRuntimeContract(this.ctx.storage.kv, fence.allocationId) !== 'worktree' ||
        !isAdoptableWorktreeScope({ grant, acceptedMarker: marker })
      ) {
        return { kind: 'per-session' };
      }

      let candidate = input.candidate;
      const staleFence =
        candidate !== null && !sameRuntimeProxyControlBinding(input.mintFence, fence);
      if (staleFence) candidate = null;
      const canonical = await this.selectCanonicalForScope(grant, fence, input.sessionId);
      const choice = decideCanonicalHandle({
        canonical: canonical === null ? null : { handle: canonical.handle, exp: canonical.exp },
        canonicalUsable: canonical?.usable ?? false,
        candidate,
        now,
        thresholdMs: this.sandboxTimers().credentialGrantReissueBelowMs,
      });

      let finalHandle: string | null = null;
      let adoptCandidate = false;
      let candidateDigest: string | null = null;
      if (choice.action === 'keep-canonical') {
        finalHandle = choice.handle;
      } else if (choice.action === 'adopt-candidate' && candidate !== null) {
        candidateDigest = await digestRuntimeProxyHandle(candidate.handle);
        const present = acceptedDigests.has(candidateDigest);
        if (!present && entries.length >= ACCEPTED_HANDLES_MAX) {
          // The set is full: keep serving a valid canonical if there is one.
          if (canonical !== null && canonical.usable && canonical.exp > now) {
            finalHandle = canonical.handle;
          }
        } else {
          finalHandle = candidate.handle;
          adoptCandidate = true;
        }
      }
      if (finalHandle === null) {
        if (staleFence) return { kind: 'stale' };
        // The canonical became unusable between the off-queue mint decision and
        // this queued claim (a release of its issuer won the queue). Remint
        // through the requestor rather than failing on a transient condition.
        if (candidate === null) return { kind: 'remint' };
        return { kind: 'fail' };
      }

      // Adopting a candidate that outlives the canonical replaces the scope's
      // canonical string; an already-adopted scope whose canonical has ended
      // (marker present, no live canonical) has no canonical to keep either. In
      // both cases every member row converges on the new handle. A first mint in
      // a scope that was never adopted, or a candidate minted only because this
      // requestor cannot be served by a still-valid canonical, writes only the
      // requestor's row.
      const replacingCanonical =
        adoptCandidate &&
        (canonical !== null ? candidate !== null && candidate.exp > canonical.exp : marker);
      const seeded = withMemberHandle(grant, finalHandle, {
        sessionId: input.sessionId,
        kiloSessionId: input.kiloSessionId,
      });
      const updated =
        adoptCandidate && replacingCanonical ? setAllMemberHandles(seeded, finalHandle) : seeded;
      if (updated === grant) return { kind: 'handle', handle: finalHandle };

      const claims = await verifyRuntimeCredentialProxyHandle(this.env, finalHandle);
      if (!claims || claims.userId !== input.ownerId) return { kind: 'fail' };
      const issuerIsMember = grant.members.some(member => member.sessionId === claims.sessionId);
      if (claims.sessionId !== input.sessionId && !issuerIsMember) {
        return adoptCandidate ? { kind: 'remint' } : { kind: 'fail' };
      }
      if (!adoptCandidate) {
        const match = await lookupAcceptedHandle(this.ctx.storage, finalHandle, fence, now);
        if (match === undefined || match.scopeGrantId !== scopeKey) return { kind: 'fail' };
      }
      if (!(await this.applyCandidateGrantPolicy(updated))) return { kind: 'fail' };

      const entry =
        adoptCandidate && candidate !== null && candidateDigest !== null
          ? {
              handleDigest: candidateDigest,
              handle: finalHandle,
              issuerSessionId: candidate.issuerSessionId,
              scopeId: grant.scopeId,
              exp: candidate.exp,
              fence,
            }
          : null;
      let committed = true;
      this.ctx.storage.transactionSync(() => {
        if (entry !== null) {
          const added = addAcceptedHandleSync(this.ctx.storage.kv, scopeKey, entry, now);
          if (added !== 'added' && added !== 'present') {
            committed = false;
            return;
          }
        }
        writeScopeGrant(this.db, updated);
      });
      if (!committed) return { kind: 'fail' };
      // The candidate replaced an existing canonical for every member: push it
      // to the members already serving the previous string.
      if (adoptCandidate && replacingCanonical) {
        await this.fanoutCanonicalCredentials(updated, allocation);
      }
      return { kind: 'handle', handle: finalHandle };
    });
  }

  /**
   * The adopted handle a scope is already serving for the current fence, matched
   * by the digest of a current member's stored string. This is the single
   * canonical selector for both prepare and maintenance. Prefer the max-exp entry
   * a current member can actually serve (its issuer is still a member, or the
   * requestor already holds it); only when none is usable fall back to the
   * max-exp entry. A departed issuer's long-lived handle therefore does not force
   * every joiner to mint another requestor-only handle.
   */
  private async selectCanonicalForScope(
    grant: SessionCredentialGrant,
    fence: ControlRuntimeCredentialProxyFence,
    requestorSessionId: string | null
  ): Promise<CanonicalHandleState | null> {
    const members = grant.kilo.runtimeProxy?.members ?? [];
    if (members.length === 0) return null;
    const entries = await listAcceptedHandlesForScope(this.ctx.storage, scopeGrantId(grant), fence);
    if (entries.length === 0) return null;
    const handlesByDigest = new Map<string, string>();
    for (const member of members) {
      handlesByDigest.set(await digestRuntimeProxyHandle(member.handle), member.handle);
    }
    let bestUsable: CanonicalHandleState | null = null;
    let bestAny: CanonicalHandleState | null = null;
    for (const entry of entries) {
      const handle = handlesByDigest.get(entry.handleDigest);
      if (handle === undefined) continue;
      const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
      if (claims === null) continue;
      const requestorHolds =
        requestorSessionId !== null &&
        members.some(member => member.sessionId === requestorSessionId && member.handle === handle);
      const issuerIsMember = grant.members.some(member => member.sessionId === claims.sessionId);
      const state: CanonicalHandleState = {
        handle,
        exp: entry.exp,
        issuerSessionId: claims.sessionId,
        usable: requestorHolds || issuerIsMember,
      };
      if (bestAny === null || state.exp > bestAny.exp) bestAny = state;
      if (state.usable && (bestUsable === null || state.exp > bestUsable.exp)) bestUsable = state;
    }
    return bestUsable ?? bestAny;
  }

  private async runtimeProxyHandleClaims(
    handle: string
  ): Promise<{ exp: number; sessionId: string } | null> {
    const claims = await verifyRuntimeCredentialProxyHandle(this.env, handle);
    return claims === null ? null : { exp: claims.exp, sessionId: claims.sessionId };
  }

  private async tryIssueCloudAgentMcpGrant(
    route: RouteRecord
  ): Promise<{ url: string; token: string; expiresAt: number } | undefined> {
    const anchor = workspaceMcpAnchorSessionId(route.credentialSource?.scopeId, route.sessionId);
    if (anchor === undefined) return undefined;
    try {
      const ownerId = await this.requireOwner();
      const peer = ownerId === null ? null : this.sessionPeerFor(ownerId, anchor);
      if (peer?.issueCloudAgentMcpGrant === undefined) return undefined;
      return await withTimeout(
        peer.issueCloudAgentMcpGrant(
          route.credentialSource?.scopeId?.startsWith('worktree_')
            ? {
                worktreeId: route.credentialSource.scopeId,
                ownerId: route.credentialSource.userId,
                organizationId: route.credentialSource.orgId ?? null,
              }
            : undefined
        ),
        this.grantIssueTimeoutMs(),
        'Cloud Agent MCP grant issuance timed out'
      );
    } catch {
      logger
        .withFields({
          sandboxId: this.sandboxId,
          sessionId: route.sessionId,
          anchorSessionId: anchor,
        })
        .warn('Optional Cloud Agent MCP grant unavailable; continuing without it');
      return undefined;
    }
  }

  /** Mint one runtime proxy handle for `fence`, bounded by the grant timeout. */
  private async mintRuntimeProxyGrant(
    peer: ControlPlaneSessionPeer,
    fence: ControlRuntimeCredentialProxyFence
  ): Promise<string | null> {
    try {
      return await withTimeout(
        peer.issueRuntimeCredentialProxyGrant(fence),
        this.grantIssueTimeoutMs(),
        'Runtime credential proxy grant issuance timed out'
      );
    } catch {
      return null;
    }
  }

  /** The current allocation's runtime credential proxy fence, or null. */
  private runtimeProxyFenceFor(state: AllocationState): ControlRuntimeCredentialProxyFence | null {
    const { allocationId, connectionId, providerRef, wrapperId } = state;
    if (
      (state.kind !== 'connected' && state.kind !== 'disconnected') ||
      allocationId === null ||
      connectionId === null ||
      providerRef === null ||
      wrapperId === null
    ) {
      return null;
    }
    return {
      plane: 'control',
      allocationId,
      providerInstanceId: providerRef,
      connectionId,
      wrapperInstanceId: wrapperId,
    };
  }

  /** Fail one preparation attempt, fenced by attempt id (late mint failure). */
  private async failPrepareAttempt(
    sessionId: string,
    attemptId: string,
    stage = 'prepare_dispatch_failed',
    reason: ControlPlaneFailureReason = 'workspace_setup_failed'
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      await failCurrentAttempt(this.routeContext(state), sessionId, attemptId, reason, stage);
    });
  }

  private async notifySession(
    sessionId: string,
    notification: SandboxNotification,
    deadlineAt: number,
    signal: AbortSignal
  ): Promise<void> {
    // One owner per sandbox (B3 review 5), stored on first prepare/registration.
    // The Session DO name is `ownerId:sessionId`, so resolve that stored owner
    // here rather than the bare session id.
    const ownerId = await this.requireOwner();
    if (Date.now() >= deadlineAt || signal.aborted) throw new Error('Notification expired');
    if (ownerId === null) throw new Error('Notification owner unavailable');
    const peer = this.sessionPeerFor(ownerId, sessionId);
    if (peer === null) throw new Error('Notification peer unavailable');
    if (notification.kind === 'events') {
      notification = {
        ...notification,
        payload: {
          ...notification.payload,
          delivery: { id: crypto.randomUUID(), expiresAt: deadlineAt },
        },
      };
    }
    await withDORetry(
      () => this.sessionPeerFor(ownerId, sessionId) ?? peer,
      target => {
        switch (notification.kind) {
          case 'events':
            return target.onEvents(notification.payload);
          case 'route':
            return target.onRoute(notification.payload);
          case 'outcome':
            return target.onOutcome(notification.payload);
          case 'worktree_changes':
            return target.onWorktreeChangesReady(notification.payload).then(subscribed => {
              // A deleted or moved session leaves; a later read subscribes it again.
              if (subscribed === false) {
                this.ctx.storage.kv.delete(
                  worktreeSubscriberKey(notification.payload.worktreeId, sessionId)
                );
              }
            });
        }
      },
      `notification.${notification.kind}`,
      {
        ...DEFAULT_DO_RETRY_CONFIG,
        scope: { deadlineAt, signal },
      }
    );
  }

  private resolveSessionPeer(ownerId: string, sessionId: string): ControlPlaneSessionPeer | null {
    const namespace = sandboxSessionPeerNamespace<ControlPlaneSessionPeer>(this.env);
    return namespace === undefined ? null : namespace.getByName(sessionDoName(ownerId, sessionId));
  }

  /**
   * The Kilo runtime that runs this allocation. The connected wrapper reports the
   * runtime it runs. Before it connects, the sandbox's stored harness attributes the
   * run, so a startup failure is not `unknown`. That fallback is exact in production,
   * where preinstalled images carry only v1. The local v2 image overrides it, so a
   * local v2 run is attributed correctly only after its wrapper connects.
   */
  private async allocationRuntimeHarness(
    state: AllocationState
  ): Promise<RuntimeHarness | undefined> {
    const socket = this.boundWrapperSocket(state);
    const reported = socket === null ? undefined : this.readAttachment(socket)?.runtimeHarness;
    return reported ?? (await this.storedRuntimeHarness());
  }

  private async storedRuntimeHarness(): Promise<RuntimeHarness | undefined> {
    return z
      .enum(RUNTIME_HARNESSES)
      .optional()
      .parse(await this.ctx.storage.get(RUNTIME_HARNESS_KEY));
  }

  private boundWrapperSocket(state: AllocationState): WebSocket | null {
    if (state.kind !== 'connected' || state.allocationId === null || state.connectionId === null) {
      return null;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (
        attachment?.allocationId === state.allocationId &&
        attachment.connectionId === state.connectionId
      ) {
        return ws;
      }
    }
    return null;
  }

  private trySendFrame(ws: WebSocket, frame: ControlPlaneWrapperFrame): boolean {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private async runEffect(effect: AllocationEffect, state: AllocationState): Promise<void> {
    switch (effect.type) {
      case 'create':
        if (this.createInFlight) return;
        // H3: the provider call runs off the serialized queue; its result
        // re-enters through applyEvent fenced on allocationId.
        this.ctx.waitUntil(this.runCreate(effect.allocationId));
        return;
      case 'stop':
        this.ctx.waitUntil(this.runStop(effect.stopAttempt));
        return;
      case 'lease':
        this.ctx.waitUntil(this.runLease());
        return;
      case 'close-socket':
        await this.runCloseSocket(state);
        return;
    }
  }

  private async runCreate(allocationId: string): Promise<void> {
    this.createInFlight = true;
    try {
      const state = await this.readAllocation();
      if (state.kind !== 'creating' || state.allocationId !== allocationId) return;
      let createdRef: string | null = null;
      try {
        const pin = this.providerPin;
        if (pin === null) throw new ProviderCreationError('invalid_configuration');
        const cohort = {
          preparingRoutes: (await listRoutes(this.db))
            .filter(route => route.state === 'preparing')
            .map(route => ({
              orgId: route.credentialSource?.orgId,
              billingOrigin: route.credentialSource?.billingOrigin,
            })),
          sandboxKind: pin.sandboxKind,
          sandboxId: this.sandboxId,
        };
        const harness = await this.runtimeHarness(pin.provider, cohort);
        const credential = generateSandboxCredential();
        const selection = selectStartup(this.env, pin.provider, cohort, harness);
        const createDeadline =
          state.createDeadlineAt ?? Date.now() + this.sandboxTimers().providerCreateMs;
        const startupCommand =
          selection.mode === 'preinstalled'
            ? preinstalledStartup()
            : await withTimeout(
                downloadedStartup({
                  env: this.env,
                  descriptor: selection.descriptor,
                  harness,
                  sandboxId: this.sandboxId,
                  allocationId,
                  deadlineAt: createDeadline + this.sandboxTimers().wrapperFirstConnectMs,
                }),
                remainingMs(createDeadline),
                'Runtime preflight timed out'
              );
        const launchEnv = await this.wrapperLaunchEnv(credential, allocationId, pin.provider);
        if (pin.billing) {
          await assertContainerCapacity(this.env, {
            subject: pin.billing.subject,
            actor: pin.billing.actor,
            instanceId: pin.billing.sandboxId,
            checkpoint: 'control-plane-create',
            billingOrigin: pin.billing.metadata?.origin,
          });
        }

        // Preflight failures must not pin a harness or mark this sandbox as legacy v1.
        await this.ctx.storage.put({
          [RUNTIME_HARNESS_KEY]: harness,
          [CREDENTIAL_HASH_KEY]: await hashSandboxCredential(credential),
        });
        const intent: ProviderCreateIntent = {
          intentId: allocationId,
          createdAt: Date.now(),
          allocationName: pin.allocationName ?? this.sandboxId,
          containment: this.resolvedContainment(),
          ...(pin.billing === null ? {} : { billing: pin.billing }),
        };
        // N2: create and launch share one bound (the create deadline).
        const created = await withTimeout(
          this.provider.create(intent),
          remainingMs(createDeadline),
          'Sandbox create timed out'
        );
        if ('unresolved' in created) {
          await this.dispatchCreateFailed(allocationId);
          return;
        }
        // N4: persist the ref before launch so an accepted `hello` never sees null.
        createdRef = created.providerRef;
        if (pin.provider === 'cloudflare-containers') {
          try {
            const containerInstanceId = this.env.SANDBOX_CONTAINERS.idFromName(
              this.sandboxId
            ).toString();
            logControlDiagnostic('container_launch_identity', {
              sandboxId: this.sandboxId,
              allocationId,
              allocationName: intent.allocationName,
              provider: pin.provider,
              containerInstanceId,
            });
          } catch {
            // Observability cannot turn a successful provider create into a failed allocation.
          }
        }
        await this.dispatchResult({
          type: 'provider-ref',
          at: Date.now(),
          allocationId,
          providerRef: createdRef,
        });
        const current = await this.readAllocation();
        if (current.kind !== 'creating' || current.allocationId !== allocationId) {
          await this.stopRef(createdRef, allocationId);
          return;
        }
        const launchDeadline = current.createDeadlineAt ?? createDeadline;
        const workspaceSnapshot = await this.workspaceSnapshotLaunch(
          allocationId,
          JSON.stringify(selection),
          selection.image,
          launchDeadline
        );
        const launch =
          workspaceSnapshot === null
            ? await this.environmentSnapshotLaunch(current, allocationId, launchDeadline)
            : {
                options: {
                  snapshot: {
                    snapshotId: workspaceSnapshot.snapshotId,
                    baseImage: workspaceSnapshot.baseImage,
                  },
                },
                selection: {
                  source: 'workspace' as const,
                  capturedAt: workspaceSnapshot.capturedAt,
                },
              };
        // Persist a placeholder before the launch so a `hello` accepted while it
        // runs confirms this allocation, and that confirmation outlives the
        // allocation stopping before the launch resolves.
        await beginRepositoryLaunch(this.ctx.storage, allocationId, selection.mode);
        if (Date.now() >= launchDeadline) throw new Error('Sandbox launch timed out');
        const launchOptions: ProviderLaunchOptions = {
          ...launch.options,
          ...(pin.provider === 'cloudflare-containers'
            ? { deadlineAt: launchDeadline, nativeImage: selection.image }
            : {}),
        };
        this.launchInFlightAllocationId = allocationId;
        let launched: { result: ProviderLaunchResult; owned: boolean };
        try {
          launched = await this.launchWithSnapshotRetry({
            allocationId,
            createdRef,
            launchDeadline,
            selection: launch.selection,
            launchEnv,
            startupCommand,
            launchOptions,
          });
        } finally {
          if (this.launchInFlightAllocationId === allocationId)
            this.launchInFlightAllocationId = null;
        }
        const snapshotMissed =
          launch.selection !== null &&
          (launched.result.snapshotFailed === true || launched.result.startSource !== 'repository');
        await this.enqueue(async () => {
          const disk = readWorkspaceSnapshotAllocation(this.db);
          if (disk?.allocationId === allocationId && disk.restore?.confirmed === false) {
            writeWorkspaceSnapshotAllocation(this.db, {
              ...disk,
              restore: snapshotMissed ? disk.restore : { ...disk.restore, confirmed: true },
              recovery: undefined,
            });
            logControlDiagnostic('workspace_snapshot_restore', {
              sandboxId: this.sandboxId,
              workspaceId: disk.owner.workspaceId,
              allocationId,
              sourceAllocationId: disk.restore.sourceAllocationId,
              reason: snapshotMissed ? 'unexpected_image_start' : 'confirmed',
            });
          }
          const latest = await this.readAllocation();
          if (latest.allocationId !== allocationId || latest.kind !== 'connected') return;
          if (snapshotMissed && launch.selection !== null) {
            // Only a wrapper that connected during the launch reaches here: the
            // retry loop fails an unowned allocation. It must not prepare the
            // image as if it were the requested snapshot.
            await this.failConnectedSnapshotMiss(
              latest,
              launch.selection,
              launched.result.snapshotFailed === true
                ? (launched.result.snapshotFailureReason ?? 'transient')
                : 'unsupported'
            );
            return;
          }
          for (const route of await listRoutes(this.db)) {
            if (route.state === 'preparing') this.sendSessionPrepare(latest, route);
          }
        });
        await this.recordLaunch(allocationId, launched.result.startSource);
        // A wrapper connected while the launch was in flight owns the
        // allocation; never stop or relaunch it.
        if (launched.owned) return;
        await this.dispatchResult({
          type: 'created',
          at: Date.now(),
          allocationId,
          providerRef: createdRef,
        });
      } catch (error) {
        if (error instanceof RetiredSandboxProviderError) {
          logControlDiagnostic(
            'create_failed',
            {
              allocationName: this.providerPin?.allocationName ?? this.sandboxId,
              stage: createdRef === null ? 'create' : 'launch',
              permanentReason: 'invalid_configuration',
              errorName: diagnosticCause(error.name),
              cause: diagnosticCause(error.message),
            },
            'warn'
          );
          await this.failCreationRoutes(allocationId, false, 'invalid_configuration');
          return;
        }
        if (error instanceof WorkspaceSnapshotLaunchError) {
          await this.failWorkspaceSnapshotStart(allocationId, error.reason, error.detail);
          return;
        }
        if (error instanceof EnvironmentSnapshotRequiredError) {
          await this.failEnvironmentSnapshotRequired(allocationId, error.block);
          return;
        }
        if (error instanceof EnvironmentSnapshotUnusableError) {
          await this.failEnvironmentSnapshotUnusable(allocationId, error);
          return;
        }
        if (error instanceof SnapshotStartFailureError) {
          await this.failSnapshotStart(allocationId, error);
          return;
        }
        if (
          error instanceof ByocVercelProviderError ||
          error instanceof VercelScmContainmentError
        ) {
          await this.failCreationRoutes(allocationId, false, error.reason);
          return;
        }
        logControlDiagnostic(
          'create_failed',
          {
            allocationName: this.providerPin?.allocationName ?? this.sandboxId,
            stage: createdRef === null ? 'create' : 'launch',
            permanentReason:
              error instanceof ProviderCreationError ? (error.permanentReason ?? 'none') : 'none',
            errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
            cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
          },
          'warn'
        );
        const capacityFailure = getContainerCapacityFailureReason(error);
        if (capacityFailure) {
          await this.failCreationRoutes(allocationId, false, capacityFailure);
          return;
        }
        if (error instanceof ProviderCreationError && error.permanentReason !== null) {
          await this.failCreationRoutes(allocationId, false, error.permanentReason);
          return;
        }
        // N5: only clean up a container the reducer still owns. If a `hello`
        // was accepted during a slow launch, the sandbox has an owner and must
        // not be destroyed here.
        if (createdRef !== null) {
          const latest = await this.readAllocation();
          if (latest.kind === 'creating' && latest.allocationId === allocationId) {
            await this.stopRef(createdRef, allocationId);
          }
        }
        await this.dispatchCreateFailed(allocationId);
      }
    } finally {
      this.createInFlight = false;
      await this.enqueue(async () => {
        const pending = await this.readAllocation();
        // Stop may finish before this launch returns. Start again only after
        // recordLaunch settles, without changing transient create retry pauses.
        if (pending.kind === 'stopped' && (await routeRetryAllowed(this.routeContext(pending)))) {
          await this.applyEvent({
            type: 'ensure',
            at: Date.now(),
            allocationId: crypto.randomUUID(),
          });
        }
      });
    }
  }

  /**
   * Native history does not move between v1 and v2, so the first allocation
   * fixes the harness for every later one. A sandbox that allocated before this
   * record existed ran v1.
   */
  private async runtimeHarness(
    provider: AgentSandboxProvider,
    cohort: StartupCohortContext
  ): Promise<RuntimeHarness> {
    const stored = await this.storedRuntimeHarness();
    if (stored !== undefined) return stored;
    return (await this.ctx.storage.get(CREDENTIAL_HASH_KEY)) === undefined
      ? newSandboxHarness(this.env, provider, cohort)
      : 'kilo';
  }

  /**
   * Resolve the authoritative workspace tail for this allocation. `null` means
   * no tail applies (feature gate off or no descriptor); a descriptor that
   * exists but cannot start throws and is retained for "Start fresh".
   */
  private async workspaceSnapshotLaunch(
    allocationId: string,
    runtimeIdentity: string,
    image: 'all-in-one' | 'runtime-free',
    launchDeadline: number
  ): Promise<{ snapshotId: string; baseImage: string; capturedAt: number } | null> {
    const log = (reason: string, sessionId?: string, workspaceId?: string) =>
      logControlDiagnostic('workspace_snapshot_launch', {
        sandboxId: this.sandboxId,
        allocationId,
        sessionId,
        workspaceId,
        reason,
      });
    const eligible = (route: RouteRecord) => this.workspaceSnapshotRouteEligible(route);
    const candidate = await this.enqueue(async () => {
      const current = await this.readAllocation();
      const routes = await listRoutes(this.db);
      const route = liveWorkspaceRoutes(routes)[0];
      if (current.kind !== 'creating' || current.allocationId !== allocationId) {
        log('allocation_changed', route?.sessionId);
        return null;
      }
      clearWorkspaceSnapshotAllocation(this.db);
      const owner = workspaceSnapshotOwner(this.sandboxId, routes);
      if (route === undefined || owner === null) {
        log(
          route?.credentialSource ? 'not_workspace_scope' : 'missing_route_credentials',
          route?.sessionId
        );
        return null;
      }
      writeWorkspaceSnapshotAllocation(this.db, { allocationId, runtimeIdentity, owner });
      log('tracking_initialized', route.sessionId, owner.workspaceId);
      const skip = workspaceSnapshotRestoreSkip(this.db, owner, routes, eligible);
      if (skip === 'missing_descriptor') {
        // A malformed descriptor reads as missing. Keep it authoritative: the
        // selection below fails instead of silently starting another source.
        if (readWorkspaceSnapshotRaw(this.db, owner.workspaceId) === undefined) {
          log(skip, route.sessionId, owner.workspaceId);
          return null;
        }
      } else if (skip !== undefined) {
        log(skip, route.sessionId, owner.workspaceId);
        return null;
      }
      return { owner, sessionId: route.sessionId };
    });
    if (candidate === null) return null;
    const snapshots = this.provider.workspaceSnapshots;
    if (snapshots === undefined) {
      log('unsupported_provider', candidate.sessionId, candidate.owner.workspaceId);
      if (readWorkspaceSnapshotRaw(this.db, candidate.owner.workspaceId) === undefined) return null;
      throw new WorkspaceSnapshotLaunchError(
        'unsupported',
        workspaceSnapshotFailureDetail('unsupported')
      );
    }
    // Resolve the current image transiently within the preparation deadline; a
    // single failed lookup does not discard a valid tail.
    const baseImage = await this.currentImageWithinDeadline(snapshots, image, launchDeadline);
    return this.enqueue(async () => {
      const current = await this.readAllocation();
      const disk = readWorkspaceSnapshotAllocation(this.db);
      const routes = await listRoutes(this.db);
      const skip =
        current.kind !== 'creating' ||
        current.allocationId !== allocationId ||
        disk?.allocationId !== allocationId
          ? 'allocation_changed'
          : !workspaceSnapshotRoutesEligible(routes, eligible)
            ? 'route_ineligible'
            : undefined;
      if (skip !== undefined) {
        log(skip, candidate.sessionId, candidate.owner.workspaceId);
        return null;
      }
      const descriptorExists =
        readWorkspaceSnapshotRaw(this.db, candidate.owner.workspaceId) !== undefined;
      if (baseImage === null) {
        log('image_unavailable', candidate.sessionId, candidate.owner.workspaceId);
        if (!descriptorExists) return null;
        throw new WorkspaceSnapshotLaunchError(
          'image_unavailable',
          workspaceSnapshotFailureDetail(
            'image_unavailable',
            readWorkspaceSnapshot(this.db, candidate.owner.workspaceId)?.capturedAt
          )
        );
      }
      const selection = selectWorkspaceSnapshotResult(
        this.db,
        candidate.owner,
        runtimeIdentity,
        baseImage,
        candidate.sessionId
      );
      if (selection.kind === 'missing') {
        log('missing_descriptor', candidate.sessionId, candidate.owner.workspaceId);
        return null;
      }
      if (selection.kind === 'unusable') {
        const descriptor = readWorkspaceSnapshot(this.db, candidate.owner.workspaceId);
        log(selection.reason, candidate.sessionId, candidate.owner.workspaceId);
        throw new WorkspaceSnapshotLaunchError(
          selection.reason,
          workspaceSnapshotFailureDetail(selection.reason, descriptor?.capturedAt)
        );
      }
      const descriptor = selection.descriptor;
      writeWorkspaceSnapshotAllocation(this.db, {
        ...disk,
        restore: { sourceAllocationId: descriptor.sourceAllocationId, confirmed: false },
      });
      log('selected', candidate.sessionId, candidate.owner.workspaceId);
      await notifyPreparingRoutes(this.routeContext(current), {
        step: 'restore',
        detail: 'Using workspace snapshot',
        snapshotCapturedAt: descriptor.capturedAt,
      });
      return {
        snapshotId: descriptor.snapshotId,
        baseImage: descriptor.baseImage,
        capturedAt: descriptor.capturedAt,
      };
    });
  }

  private async currentImageWithinDeadline(
    snapshots: NonNullable<ProviderAdapter['workspaceSnapshots']>,
    image: 'all-in-one' | 'runtime-free',
    launchDeadline: number
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const budget = Math.min(1_000, launchDeadline - Date.now() - 1_000);
      if (budget <= 0) return null;
      try {
        return await withTimeout(
          snapshots.currentImage(image),
          budget,
          'Snapshot image lookup timed out'
        );
      } catch {
        if (attempt === 2) return null;
      }
    }
    return null;
  }

  /**
   * An environment that supplies build commands may only start from its own
   * snapshot. An environment without build commands starts from the base image
   * per the startup table, even if an older snapshot exists.
   */
  private async environmentSnapshotLaunch(
    state: AllocationState,
    allocationId: string,
    launchDeadlineAt: number
  ): Promise<{ options: ProviderLaunchOptions; selection: SnapshotStartSelection | null }> {
    const routes = await listRoutes(this.db);
    const selected = environmentLaunchCandidate(routes);
    const log = (fields: Record<string, string | number | boolean | undefined>) =>
      logControlDiagnostic('snapshot_launch', {
        sandboxId: this.sandboxId,
        allocationId,
        ...fields,
      });
    const environmentId = routes.find(route => route.state === 'preparing')?.environment
      ?.environmentId;
    const buildCommands = routes
      .filter(route => route.state === 'preparing')
      .reduce((max, route) => Math.max(max, route.spec.environmentSetupCommandCount ?? 0), 0);
    if (buildCommands > 0) {
      // Build commands run only in an environment build. When no environment
      // snapshot can serve this start, rebuilding cannot help: fail at once.
      const unusable =
        this.provider.environmentSnapshots !== true
          ? 'provider_no_snapshots'
          : 'reason' in selected && selected.reason === 'not_isolated'
            ? 'not_isolated'
            : null;
      if (unusable !== null) {
        log({ reason: unusable });
        throw new EnvironmentSnapshotUnusableError(
          unusable,
          ENVIRONMENT_SNAPSHOT_UNUSABLE_DETAIL[unusable],
          environmentId ?? ''
        );
      }
    }
    if (!('candidate' in selected)) {
      log({ reason: selected.reason });
      // An environment with build commands may not fall back to the image.
      if (buildCommands > 0) {
        throw new EnvironmentSnapshotRequiredError(
          this.environmentRequiredBlock(selected.reason, environmentId)
        );
      }
      return { options: {}, selection: null };
    }
    const { candidate } = selected;
    if (candidate.buildCommands === 0) {
      log({ reason: 'no_build_commands' });
      return { options: {}, selection: null };
    }
    const lookup = await lookupEnvironmentSnapshot({
      namespace: this.env.ENVIRONMENT_BUILD,
      candidate,
      launchDeadlineAt,
    });
    const decision = environmentSnapshotDecision(candidate, lookup);
    if (decision.kind === 'blocked') {
      log({
        reason: decision.block.reason,
        buildId: decision.block.buildId ?? undefined,
        environmentId: decision.block.environmentId,
      });
      await notifyPreparingRoutes(this.routeContext(state), {
        step: 'environment_snapshot',
        detail: decision.block.detail,
      });
      throw new EnvironmentSnapshotRequiredError(decision.block);
    }
    log({
      reason: lookup.kind === 'resolved' ? lookup.resolution.reason : lookup.kind,
      admission: lookup.kind === 'resolved' ? lookup.resolution.admission.status : undefined,
      sessionRevision: candidate.reference.configurationRevision,
      snapshotRevision:
        lookup.kind === 'resolved'
          ? (lookup.resolution.snapshot?.revision ?? undefined)
          : undefined,
      stale:
        lookup.kind === 'resolved' ? (lookup.resolution.snapshot?.stale ?? undefined) : undefined,
    });
    await notifyPreparingRoutes(this.routeContext(state), {
      step: 'environment_snapshot',
      detail: environmentStartDetail(candidate.reference, lookup),
      ...(lookup.kind === 'resolved' && lookup.resolution.snapshot !== null
        ? { snapshotCapturedAt: lookup.resolution.snapshot.capturedAt }
        : {}),
    });
    return {
      options: decision.snapshot === undefined ? {} : { snapshot: decision.snapshot },
      selection:
        decision.snapshot === undefined
          ? null
          : {
              source: 'environment',
              candidate,
              buildId: environmentBuildIdOfLookup(lookup),
            },
    };
  }

  private environmentRequiredBlock(
    reason: string,
    environmentId: string | undefined
  ): EnvironmentSnapshotBlock {
    const blockedEnvironmentId = environmentId ?? '';
    switch (reason) {
      case 'multiple_environments':
        return {
          reason: 'environment_snapshot_unavailable',
          detail:
            'The sessions use different environment revisions, so no single environment snapshot applies. Align the environment revision and retry.',
          environmentId: blockedEnvironmentId,
          buildId: null,
        };
      case 'no_actor':
        return {
          reason: 'environment_snapshot_unavailable',
          detail:
            'The environment snapshot owner could not be identified. Retry from an authenticated session.',
          environmentId: blockedEnvironmentId,
          buildId: null,
        };
      default:
        return {
          reason: 'environment_not_built',
          detail: 'The session requires an environment build, but no environment is available.',
          environmentId: blockedEnvironmentId,
          buildId: null,
        };
    }
  }

  /**
   * Remember how this allocation's container started. A wrapper that connected
   * while a slow launch was still returning has already confirmed the start
   * through the placeholder `beginRepositoryLaunch` wrote, so keep that
   * confirmation even if the allocation has since stopped.
   *
   * Emits one `snapshot_start` diagnostic per allocation so `image` vs
   * `repository` is durable evidence of whether a snapshot was actually used.
   */
  private async recordLaunch(
    allocationId: string,
    startSource: ProviderStartSource
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      const connected =
        state.allocationId === allocationId &&
        (state.kind === 'connected' || state.kind === 'disconnected');
      const existing = await readRepositoryLaunch(this.ctx.storage);
      if (existing?.allocationId !== allocationId) return;
      const confirmed = connected || existing.confirmed;
      await recordRepositoryLaunch(this.ctx.storage, {
        allocationId,
        startSource,
        startupMode: existing.startupMode ?? 'preinstalled',
        confirmed,
      });
      logControlDiagnostic('snapshot_start', {
        sandboxId: this.sandboxId,
        allocationId,
        source: startSource,
        confirmed,
      });
    });
  }

  /**
   * One provider start with a bounded retry of the same snapshot artifact. A
   * permanent reason fails at once; a transient reason is observed twice before
   * failing. A wrapper that connects while the launch is in flight owns the
   * allocation, so it is never stopped or relaunched.
   */
  private async launchWithSnapshotRetry(input: {
    allocationId: string;
    createdRef: string;
    launchDeadline: number;
    selection: SnapshotStartSelection | null;
    launchEnv: Record<string, string>;
    startupCommand: ProviderStartupCommand;
    launchOptions: ProviderLaunchOptions;
  }): Promise<{ result: ProviderLaunchResult; owned: boolean }> {
    const requestedSnapshot = input.launchOptions.snapshot !== undefined;
    for (let attempt = 1; ; attempt += 1) {
      if (Date.now() >= input.launchDeadline) {
        if (!requestedSnapshot) throw new Error('Sandbox launch timed out');
        throw this.snapshotStartFailure(input.selection, 'transient');
      }
      let result: ProviderLaunchResult;
      try {
        result = await withTimeout(
          this.provider.launch(
            input.createdRef,
            { command: input.startupCommand, env: input.launchEnv },
            input.launchOptions
          ),
          remainingMs(input.launchDeadline),
          'Sandbox launch timed out'
        );
      } catch (error) {
        if (!requestedSnapshot) throw error;
        if (await this.allocationOwnedElsewhere(input.allocationId)) {
          return {
            result: { startSource: 'repository' },
            owned: true,
          };
        }
        if (attempt >= 2 || Date.now() >= input.launchDeadline)
          throw this.snapshotStartFailure(input.selection, 'transient');
        const retry = await this.stopForSnapshotRetry(input.createdRef, input.allocationId);
        if (retry === 'owned') return { result: { startSource: 'repository' }, owned: true };
        if (retry === 'failed') throw this.snapshotStartFailure(input.selection, 'transient');
        continue;
      }
      const startedFromSnapshot = !result.snapshotFailed && result.startSource === 'repository';
      if (!requestedSnapshot) return { result, owned: false };
      if (startedFromSnapshot) return { result, owned: false };
      const reason: SnapshotStartFailureReason = result.snapshotFailed
        ? (result.snapshotFailureReason ?? 'transient')
        : 'unsupported';
      // An owned allocation fails through `failConnectedSnapshotMiss`, which
      // handles a connected wrapper; the creation fail path does not.
      if (await this.allocationOwnedElsewhere(input.allocationId)) {
        return { result, owned: true };
      }
      if (
        snapshotStartFailureIsPermanent(reason) ||
        attempt >= 2 ||
        Date.now() >= input.launchDeadline
      )
        throw this.snapshotStartFailure(input.selection, reason);
      const retry = await this.stopForSnapshotRetry(input.createdRef, input.allocationId);
      if (retry === 'owned') return { result, owned: true };
      if (retry === 'failed') throw this.snapshotStartFailure(input.selection, reason);
    }
  }

  private async allocationOwnedElsewhere(allocationId: string): Promise<boolean> {
    const latest = await this.readAllocation();
    return latest.kind !== 'creating' || latest.allocationId !== allocationId;
  }

  private async stopForSnapshotRetry(
    createdRef: string,
    allocationId: string
  ): Promise<'retry' | 'owned' | 'failed'> {
    if (await this.allocationOwnedElsewhere(allocationId)) return 'owned';
    const confirmed = await this.stopRef(createdRef, allocationId);
    return confirmed ? 'retry' : 'failed';
  }

  private snapshotStartFailure(
    selection: SnapshotStartSelection | null,
    reason: SnapshotStartFailureReason
  ): SnapshotStartFailureError {
    if (selection?.source === 'workspace') {
      const since = `Start fresh discards changes since ${new Date(selection.capturedAt).toISOString()}.`;
      const detail =
        reason === 'expired'
          ? `The workspace snapshot expired. ${since}`
          : reason === 'missing'
            ? `The workspace snapshot is missing. ${since}`
            : reason === 'image_mismatch'
              ? `The workspace snapshot was captured from a different sandbox image. ${since}`
              : reason === 'provenance'
                ? `The workspace snapshot failed its provenance check. ${since}`
                : reason === 'unsupported'
                  ? `The provider did not restore the workspace snapshot. ${since}`
                  : `The workspace snapshot could not start. Send a message to retry. ${since}`;
      return new SnapshotStartFailureError('workspace', reason, detail);
    }
    const detail =
      reason === 'transient'
        ? 'The environment snapshot could not start. Rebuild the environment and retry.'
        : reason === 'expired'
          ? 'The environment snapshot expired. Rebuild the environment and retry.'
          : 'The environment snapshot cannot start. Rebuild the environment and retry.';
    const block =
      selection?.source === 'environment'
        ? environmentSnapshotStartBlock(selection.candidate, selection.buildId ?? null)
        : undefined;
    return new SnapshotStartFailureError('environment', reason, detail, block);
  }

  private async failWorkspaceSnapshotStart(
    allocationId: string,
    reason: WorkspaceSnapshotFailureReason,
    detail: string
  ): Promise<void> {
    await this.recordWorkspaceSnapshotRecovery(allocationId, reason);
    await this.notifySnapshotStartFailure(allocationId, 'restore', detail);
    await this.failCreationRoutes(
      allocationId,
      false,
      'workspace_setup_failed',
      'workspace_snapshot_start_failed'
    );
  }

  private async failEnvironmentSnapshotRequired(
    allocationId: string,
    block: EnvironmentSnapshotBlock
  ): Promise<void> {
    await this.notifySnapshotStartFailure(allocationId, 'environment_snapshot', block.detail);
    await this.failCreationRoutes(
      allocationId,
      false,
      'workspace_setup_failed',
      'environment_snapshot_required'
    );
    logControlDiagnostic('snapshot_start_blocked', {
      sandboxId: this.sandboxId,
      allocationId,
      reason: block.reason,
      environmentId: block.environmentId,
      buildId: block.buildId ?? undefined,
    });
  }

  private async failEnvironmentSnapshotUnusable(
    allocationId: string,
    error: EnvironmentSnapshotUnusableError
  ): Promise<void> {
    await this.notifySnapshotStartFailure(allocationId, 'sandbox_create', error.detail);
    await this.failCreationRoutes(
      allocationId,
      false,
      'workspace_setup_failed',
      'environment_snapshot_required'
    );
    logControlDiagnostic('snapshot_start_blocked', {
      sandboxId: this.sandboxId,
      allocationId,
      reason: error.reason,
      environmentId: error.environmentId,
    });
  }

  private async failSnapshotStart(
    allocationId: string,
    error: SnapshotStartFailureError
  ): Promise<void> {
    if (error.source === 'workspace') {
      await this.recordWorkspaceSnapshotRecovery(allocationId, error.reason);
      await this.notifySnapshotStartFailure(allocationId, 'restore', error.detail);
      await this.failCreationRoutes(
        allocationId,
        false,
        'workspace_setup_failed',
        'workspace_snapshot_start_failed'
      );
      return;
    }
    const block = error.environmentBlock ?? {
      reason: 'environment_snapshot_start_failed',
      detail: error.detail,
      environmentId: '',
      buildId: null,
    };
    await this.notifySnapshotStartFailure(allocationId, 'environment_snapshot', block.detail);
    await this.failCreationRoutes(
      allocationId,
      false,
      'workspace_setup_failed',
      'environment_snapshot_required'
    );
    logControlDiagnostic('snapshot_start_blocked', {
      sandboxId: this.sandboxId,
      allocationId,
      reason: block.reason,
      environmentId: block.environmentId,
      buildId: block.buildId ?? undefined,
    });
  }

  /**
   * A wrapper connected while a snapshot launch was in flight, and the provider
   * then reported the image. The preparing routes fail with the snapshot's
   * reason and the allocation stops, so the next start selects the snapshot again
   * instead of continuing on the image. Runs on the serial queue.
   */
  private async failConnectedSnapshotMiss(
    state: AllocationState,
    selection: SnapshotStartSelection,
    reason: SnapshotStartFailureReason
  ): Promise<void> {
    const failure = this.snapshotStartFailure(selection, reason);
    const ctx = this.routeContext(state);
    if (failure.source === 'workspace') {
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (disk?.allocationId === state.allocationId && state.allocationId !== null)
        writeWorkspaceSnapshotAllocation(this.db, {
          ...disk,
          restore: undefined,
          recovery: {
            allocationId: state.allocationId,
            reason,
            failedAt: Date.now(),
          },
        });
    }
    const step = failure.source === 'workspace' ? 'restore' : 'environment_snapshot';
    const detail = failure.environmentBlock?.detail ?? failure.detail;
    await notifyPreparingRoutes(ctx, { step, detail });
    for (const route of await listRoutes(this.db)) {
      if (route.state !== 'preparing') continue;
      await onRouteFailed(
        ctx,
        route.sessionId,
        'workspace_setup_failed',
        failure.source === 'workspace'
          ? 'workspace_snapshot_start_failed'
          : 'environment_snapshot_required',
        true
      );
    }
    await this.applyEvent({
      type: 'stop-requested',
      at: Date.now(),
      reason: 'workspace_setup_failed',
    });
  }

  private async notifySnapshotStartFailure(
    allocationId: string,
    step: 'restore' | 'environment_snapshot' | 'sandbox_create',
    detail: string
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      if (state.kind !== 'creating' || state.allocationId !== allocationId) return;
      await notifyPreparingRoutes(this.routeContext(state), { step, detail });
    });
  }

  private async recordWorkspaceSnapshotRecovery(
    allocationId: string,
    reason: string
  ): Promise<void> {
    await this.enqueue(async () => {
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (disk?.allocationId !== allocationId) return;
      writeWorkspaceSnapshotAllocation(this.db, {
        ...disk,
        recovery: { allocationId, reason, failedAt: Date.now() },
      });
    });
  }

  private async dispatchCreateFailed(allocationId: string): Promise<void> {
    await this.dispatchResult({
      type: 'create-failed',
      at: Date.now(),
      allocationId,
      nextAllocationId: crypto.randomUUID(),
      retryAllowed: await this.retryAllowed(),
    });
  }

  private async stopRef(ref: string, allocationId: string | null): Promise<boolean> {
    const result = await withTimeout(
      this.provider.stop(ref, null),
      this.sandboxTimers().providerStopAttemptMs,
      'Sandbox cleanup stop timed out'
    ).catch(() => 'retryable' as const);
    logControlDiagnostic('stop_origin', {
      origin: 'cleanup',
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      allocationId,
      result,
    });
    return result === 'terminal';
  }

  private async runStop(stopAttempt: number): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'stopping' || state.stopAttempt !== stopAttempt || state.stopPending) return;
    const intent: ProviderAllocationIntent = {
      intentId: state.allocationId ?? '',
      createdAt: Date.now(),
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
    };
    let confirmed = false;
    try {
      const result = await withTimeout(
        this.provider.stop(state.providerRef, intent),
        this.sandboxTimers().providerStopAttemptMs,
        'Sandbox stop timed out'
      );
      confirmed = result === 'terminal';
    } catch {
      confirmed = false;
    }
    logControlDiagnostic('stop_origin', {
      origin: 'ladder',
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      allocationId: state.allocationId,
      stopAttempt,
      confirmed,
    });
    await this.dispatchResult({
      type: 'stop-result',
      at: Date.now(),
      allocationId: state.allocationId,
      stopAttempt,
      confirmed,
    });
  }

  /**
   * B10 deletion stop: a bounded provider stop that reports whether the
   * provider confirmed a terminal stop. Runs outside the serial queue.
   */
  private async stopProviderConfirmed(
    providerRef: string | null,
    allocationId: string | null
  ): Promise<boolean> {
    const intent: ProviderAllocationIntent = {
      intentId: allocationId ?? '',
      createdAt: Date.now(),
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
    };
    try {
      return (
        (await withTimeout(
          this.provider.stop(providerRef, intent),
          this.sandboxTimers().providerStopAttemptMs,
          'Worktree deletion stop timed out'
        )) === 'terminal'
      );
    } catch {
      return false;
    }
  }

  private async revokeWorktreeRoutes(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.notifications.retire(sessionId);
      await deleteRoute(this.db, this.ctx.storage.kv, sessionId);
    }
  }

  private async observeWorktreeRuntime(
    providerRef: string | null
  ): Promise<{ status: 'active' | 'terminal' | 'unknown' }> {
    try {
      return await withTimeout(
        this.provider.observe(providerRef),
        this.sandboxTimers().providerStopAttemptMs,
        'Worktree runtime observation timed out'
      );
    } catch {
      return { status: 'unknown' };
    }
  }

  private async runLease(): Promise<void> {
    const state = await this.readAllocation();
    if (state.kind !== 'connected' || state.providerRef === null) return;
    await withTimeout(
      this.provider.ensureLeaseAtLeast(state.providerRef, this.sandboxTimers().providerLeaseMs),
      this.sandboxTimers().providerStopAttemptMs,
      'Sandbox lease renewal timed out'
    ).catch(error => {
      logControlDiagnostic(
        'lease_renewal_failed',
        {
          allocationName: this.providerPin?.allocationName ?? this.sandboxId,
          allocationId: state.allocationId,
          errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
          cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
        },
        'warn'
      );
    });
  }

  private async runCloseSocket(state: AllocationState): Promise<void> {
    if (state.allocationId === null || state.connectionId === null) return;
    await this.applyEvent({
      type: 'socket-closed',
      at: Date.now(),
      allocationId: state.allocationId,
      connectionId: state.connectionId,
      origin: 'heartbeat_timeout',
    });
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (
        attachment?.allocationId === state.allocationId &&
        attachment.connectionId === state.connectionId
      ) {
        // A server-side close drops the wrapper without a `webSocketClose`, so
        // settle its outstanding control requests here instead of waiting out
        // the full request timeout.
        this.settlePendingForSocket(
          ws,
          controlRequestFailure('not_ready', 'Wrapper disconnected', true)
        );
        ws.serializeAttachment({ credential: attachment.credential ?? null });
        try {
          ws.close(1000, 'heartbeat timeout');
        } catch {
          // Socket already closed.
        }
      }
    }
  }

  private async dispatchResult(event: AllocationEvent): Promise<void> {
    await this.enqueue(() => this.applyEvent(event));
  }

  private readAttachment(ws: WebSocket): WrapperSocketAttachment | null {
    const parsed = wrapperSocketAttachmentSchema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  private earliestHelloDeadlineAt(): number | null {
    let earliest: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.readAttachment(ws)?.helloDeadlineAt;
      if (ws.readyState === WebSocket.OPEN && deadline !== undefined) {
        earliest = Math.min(earliest ?? Infinity, deadline);
      }
    }
    return earliest;
  }

  private expireUnboundSockets(now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const deadline = this.readAttachment(ws)?.helloDeadlineAt;
      if (deadline !== undefined && deadline <= now) {
        ws.serializeAttachment({ credential: null });
        ws.close(1008, 'Hello timeout');
      }
    }
  }

  private async readWrapperBillingBlock(state: AllocationState): Promise<boolean> {
    return (await this.provider.isBillingBlocked?.(state.providerRef)) ?? false;
  }

  private async handleFrame(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const deadline = this.readAttachment(ws)?.helloDeadlineAt;
    if (deadline !== undefined && deadline <= Date.now()) {
      this.expireUnboundSockets(Date.now());
      await this.armAlarm(await this.readAllocation());
      return;
    }
    let parsedMessage: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsedMessage = JSON.parse(text);
    } catch {
      return;
    }
    if (isLegacyWrapperFrame(parsedMessage)) {
      ws.close(1008, 'Unsupported protocol');
      return;
    }
    if (
      isRecord(parsedMessage) &&
      parsedMessage.type === 'hello' &&
      parsedMessage.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION
    ) {
      this.sendFrame(ws, { type: 'shutdown', reason: 'unsupported_protocol_version' });
      ws.close(1008, 'Unsupported protocol');
      return;
    }
    const result = controlPlaneWrapperFrameSchema.safeParse(parsedMessage);
    if (!result.success) return;
    const frame = result.data;
    const attachment = this.readAttachment(ws);

    if (frame.type === 'hello') {
      if (attachment?.connectionId !== undefined) return;
      const credential = typeof attachment?.credential === 'string' ? attachment.credential : null;
      const accepted = await this.validateAllocationCredential(
        frame.allocationId,
        credential,
        attachment?.runtimeHarness
      );
      if (!accepted) {
        this.sendFrame(ws, { type: 'shutdown', reason: 'hello_rejected' });
        ws.close(1008, 'shutdown');
        return;
      }
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (
        disk?.allocationId === frame.allocationId &&
        disk.restore !== undefined &&
        frame.workspaceSnapshots !== true
      ) {
        logControlDiagnostic('workspace_snapshot_capability', {
          sandboxId: this.sandboxId,
          workspaceId: disk.owner.workspaceId,
          allocationId: frame.allocationId,
          wrapperId: frame.wrapperId,
          advertised: frame.workspaceSnapshots === true,
          accepted: false,
          reason: 'restore_requires_capability',
        });
        this.sendFrame(ws, { type: 'shutdown', reason: 'hello_rejected' });
        ws.close(1008, 'Workspace snapshot capability required');
        this.ctx.waitUntil(
          this.failWorkspaceSnapshotStart(
            frame.allocationId,
            'unsupported',
            workspaceSnapshotFailureDetail('unsupported')
          )
        );
        return;
      }
      if (
        !acceptRuntimeContract(
          this.ctx.storage.kv,
          frame.allocationId,
          attachment?.runtimeCapability
        )
      ) {
        this.sendFrame(ws, { type: 'shutdown', reason: 'hello_rejected' });
        ws.close(1008, 'Runtime contract mismatch');
        return;
      }
      const connectionId = crypto.randomUUID();
      this.releaseBoundSockets(ws, frame.allocationId);
      ws.serializeAttachment({
        credential,
        allocationId: frame.allocationId,
        connectionId,
        wrapperId: frame.wrapperId,
        ...(attachment?.runtimeCapability
          ? { runtimeCapability: attachment.runtimeCapability }
          : {}),
        ...(frame.heartbeatAck ? { heartbeatAck: true } : {}),
        ...(frame.workspaceSnapshots ? { workspaceSnapshots: true } : {}),
        ...(frame.redactsNamedSecrets ? { redactsNamedSecrets: true } : {}),
        ...(frame.installsSkillsSh ? { installsSkillsSh: true } : {}),
        ...(frame.startCommands ? { startCommands: true } : {}),
        ...(frame.worktreeGit ? { worktreeGit: true } : {}),
        ...(attachment?.workspaceConfiguration ? { workspaceConfiguration: true } : {}),
        ...runtimeHarnessField(attachment?.runtimeHarness),
      });
      logControlDiagnostic('workspace_snapshot_capability', {
        sandboxId: this.sandboxId,
        workspaceId: disk?.owner.workspaceId,
        allocationId: frame.allocationId,
        wrapperId: frame.wrapperId,
        connectionId,
        advertised: frame.workspaceSnapshots === true,
        accepted: frame.workspaceSnapshots === true,
        reason: frame.workspaceSnapshots === true ? 'accepted' : 'not_advertised',
      });
      // Welcome first, then route effects: a re-prepared route resends
      // `session.prepare`, which must not arrive before the welcome.
      this.sendFrame(ws, {
        type: 'welcome',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        ...(frame.heartbeatAck ? { heartbeatAck: true } : {}),
        ...(frame.workspaceSnapshots ? { workspaceSnapshots: true } : {}),
      });
      writeRuntimeIdentity(this.ctx.storage.kv, frame.allocationId, {
        kiloCliVersion: attachment?.kiloCliVersion ?? null,
        wrapperVersion: attachment?.wrapperVersion ?? null,
      });
      await this.applyEvent({
        type: 'hello-accepted',
        at: Date.now(),
        allocationId: frame.allocationId,
        connectionId,
        wrapperId: frame.wrapperId,
      });
      await confirmRepositoryLaunch(this.ctx.storage, frame.allocationId);
      return;
    }

    // Frames from an unbound or superseded socket are ignored: a heartbeat
    // before `hello`, or a late frame from a replaced connection, cannot move
    // the allocation.
    if (
      attachment?.allocationId === undefined ||
      attachment.connectionId === undefined ||
      attachment.wrapperId === undefined
    ) {
      return;
    }

    const currentState = await this.readAllocation();
    const current = connectionMatches(
      currentState,
      attachment.allocationId,
      attachment.connectionId
    );
    const now = Date.now();
    if (current && now - (attachment.billingCheckedAt ?? 0) >= WRAPPER_BILLING_CHECK_MS) {
      const blocked = await withTimeout(
        this.readWrapperBillingBlock(currentState),
        this.billingReadTimeoutMs(),
        'Sandbox billing state read timed out'
      ).catch(() => false);
      if (blocked) {
        await this.applyEvent({ type: 'stop-requested', at: now, reason: 'billing_blocked' });
        this.settlePendingForSocket(
          ws,
          controlRequestFailure('not_ready', 'Wrapper disconnected', true)
        );
        ws.close(4402, 'Container billing blocked');
        return;
      }
      ws.serializeAttachment({ ...attachment, billingCheckedAt: now });
    }

    if (frame.type === 'heartbeat') {
      const state = currentState;
      if (!connectionMatches(state, attachment.allocationId, attachment.connectionId)) return;
      const at = Date.now();
      await this.applyEvent({
        type: 'heartbeat',
        at,
        allocationId: attachment.allocationId,
        connectionId: attachment.connectionId,
        active: frame.active,
      });
      if (frame.active || frame.workspaceBusy === true)
        this.fenceWorkspaceSnapshot(frame.active ? 'active' : 'workspace_busy');
      const disk = readWorkspaceSnapshotAllocation(this.db);
      if (
        !frame.active &&
        frame.workspaceBusy !== true &&
        disk?.allocationId === state.allocationId &&
        state.connectionId !== null
      ) {
        writeWorkspaceSnapshotAllocation(this.db, {
          ...disk,
          idleConnectionId: state.connectionId,
        });
      }
      await this.armAlarm(await this.readAllocation());
      if (
        !frame.active &&
        state.lastActivityAt !== null &&
        at >= state.lastActivityAt + this.sandboxIdleTimeoutMs(state)
      ) {
        await this.applyEvent({ type: 'stop-requested', at, reason: 'sandbox_stopped' });
      }
      if (
        attachment.heartbeatAck &&
        connectionMatches(
          await this.readAllocation(),
          attachment.allocationId,
          attachment.connectionId
        ) &&
        ws.readyState === WebSocket.OPEN &&
        this.readAttachment(ws)?.connectionId === attachment.connectionId
      ) {
        this.sendFrame(ws, { type: 'heartbeat_ack' });
      }
      return;
    }

    // Every other frame means only that the socket is alive; the heartbeat
    // persists that liveness. Session frames also drive routes and are forwarded
    // to the session.
    // A superseded socket can stay open (the DO does not close it on
    // `stopping`), so only the current connection may move a route or forward.
    const ctx = this.routeContext(currentState);
    switch (frame.type) {
      case 'session.progress':
        await onRouteProgress(
          ctx,
          frame.sessionId,
          {
            step: frame.step,
            ...(frame.detail === undefined ? {} : { detail: frame.detail }),
          },
          current
        );
        return;
      case 'session.ready':
        if (frame.workspace !== undefined) {
          logger
            .withFields({ sessionId: frame.sessionId, workspace: frame.workspace })
            .info('Control-plane workspace ready');
        }
        // Reconcile credentials for an adopted route that missed a fanout before
        // it is published ready. This handler already runs on the serial queue,
        // so a rotation cannot land between the resend and the transition.
        if (current) {
          await this.ensureRouteCredentialsCurrent(frame.sessionId, currentState);
          await this.captureCommandFailureNote(frame.sessionId, frame.commandFailures);
        }
        await onRouteReady(ctx, frame.sessionId, current);
        return;
      case 'workspace.capture':
        // Legacy template capture cannot create private session checkpoints.
        if (current) {
          this.trySendFrame(ws, {
            type: 'workspace.captured',
            sessionId: frame.sessionId,
            ok: false,
          });
        }
        return;
      case 'session.failed':
        logger
          .withFields({
            sessionId: frame.sessionId,
            step: frame.step ?? 'unknown',
            reason: frame.reason,
            ...(frame.subtype === undefined ? {} : { subtype: frame.subtype }),
          })
          .warn('Control-plane prepare failed');
        if (frame.reason === 'workspace_setup_failed') {
          const disk = readWorkspaceSnapshotAllocation(this.db);
          if (
            currentState.allocationId !== null &&
            disk?.allocationId === currentState.allocationId &&
            disk.restore !== undefined &&
            frame.step === 'restore'
          ) {
            // A wrapper-side tail failure is permanent: the descriptor is kept
            // for an explicit "Start fresh" and this attempt never relaunches
            // from an image.
            writeWorkspaceSnapshotAllocation(this.db, {
              ...disk,
              recovery: {
                allocationId: currentState.allocationId,
                reason: 'workspace_wrapper_failed',
                failedAt: Date.now(),
              },
            });
            if (current) {
              const capturedAt = readWorkspaceSnapshot(this.db, disk.owner.workspaceId)?.capturedAt;
              await notifyPreparingRoutes(ctx, {
                step: 'restore',
                detail: `The workspace snapshot could not be prepared. ${
                  capturedAt === undefined
                    ? 'Start fresh to discard it and start again.'
                    : `Start fresh discards changes since ${new Date(capturedAt).toISOString()}.`
                }`,
              });
            }
            await onRouteFailed(
              ctx,
              frame.sessionId,
              'workspace_setup_failed',
              'workspace_snapshot_start_failed',
              current
            );
            return;
          }
        }
        await onRouteFailed(ctx, frame.sessionId, frame.reason, frame.subtype, current);
        return;
      case 'session.events':
        this.forwardEvents(frame, current);
        return;
      case 'session.outcome':
        this.forwardOutcome(frame, current);
        return;
      case 'events_dropped':
        if (current) this.notifications.wrapperDropped(frame.dropped);
        return;
      case 'history.page':
        // Off the serial queue: a Session DO read must not hold other frames.
        if (current)
          this.ctx.waitUntil(
            serveHistoryPage({
              frame,
              readRoute: sessionId => readRoute(this.db, sessionId),
              session: async sessionId => {
                const owner = await this.requireOwner();
                return owner === null ? null : this.sessionPeerFor(owner, sessionId);
              },
              send: result => this.trySendFrame(ws, result),
            })
          );
        return;
      default:
        return;
    }
  }

  private releaseBoundSockets(ws: WebSocket, allocationId: string): void {
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const attachment = this.readAttachment(other);
      if (attachment?.allocationId !== allocationId || attachment.connectionId === undefined)
        continue;
      // A replaced wrapper is about to be closed by `other.close`; settle its
      // outstanding control requests now (the close handler may not run).
      this.settlePendingForSocket(
        other,
        controlRequestFailure('not_ready', 'Wrapper disconnected', true)
      );
      // The attachment stays: the connectionId fence, not the cleared binding,
      // is what stops a replaced socket's late close from disconnecting.
      try {
        other.close(1000, 'replaced');
      } catch {
        // Socket already closed.
      }
    }
  }

  private async validateAllocationCredential(
    allocationId: string,
    credential: string | null,
    runtimeHarness?: RuntimeHarness
  ): Promise<boolean> {
    const state = await this.readAllocation();
    const admission = {
      allocationName: this.providerPin?.allocationName ?? this.sandboxId,
      runtimeHarness,
      allocationKind: state.kind,
      expectedAllocationId: state.allocationId,
      receivedAllocationId: allocationId,
      credentialPresent: credential !== null,
    };
    const reject = (reason: string, extra: ControlDiagnosticFields = {}): boolean => {
      logControlDiagnostic('hello_admission', { ...admission, accepted: false, reason, ...extra });
      return false;
    };
    if (this.currentProvider() === 'vercel' && this.providerPin?.byoc === undefined)
      return reject('byoc_credential_missing');
    if (state.kind === 'stopped' || state.kind === 'stopping') {
      return reject(`allocation_${state.kind}`);
    }
    if (state.allocationId === null || allocationId !== state.allocationId) {
      return reject('allocation_mismatch');
    }
    if (credential === null) return reject('missing_credential');
    const storedHash = await this.ctx.storage.get<string>(CREDENTIAL_HASH_KEY);
    if (typeof storedHash !== 'string' || storedHash.length === 0) {
      return reject('missing_credential_hash', { credentialHashPresent: false });
    }
    if (!(await sandboxCredentialMatchesHash(credential, storedHash))) {
      return reject('credential_mismatch', { credentialHashPresent: true });
    }
    logControlDiagnostic('hello_admission', { ...admission, accepted: true, reason: 'accepted' });
    return true;
  }

  private sendFrame(ws: WebSocket, frame: ControlPlaneWrapperFrame): void {
    this.trySendFrame(ws, frame);
  }

  private async wrapperLaunchEnv(
    credential: string,
    allocationId: string,
    provider: AgentSandboxProvider
  ): Promise<Record<string, string>> {
    const signingSecret = await withTimeout(
      resolveSecret(this.env.NEXTAUTH_SECRET),
      1_000,
      'Wrapper launch signing secret lookup timed out'
    ).catch(() => null);
    if (!signingSecret) throw new Error('Wrapper launch signing unavailable');
    const launchCredential = mintSandboxLaunchCredential(
      { sandboxId: this.sandboxId, allocationId, credential },
      signingSecret
    );
    const workloadCgroup = (this.env as { CONTROL_WORKLOAD_CGROUP?: unknown })
      .CONTROL_WORKLOAD_CGROUP;
    return {
      ...buildControlWrapperLaunchEnv({
        workerUrl: this.env.WORKER_URL,
        sandboxId: this.sandboxId,
        provider,
        credential: launchCredential,
        diagnostics: { allocationId, signingSecret },
        ...(typeof workloadCgroup === 'string' ? { workloadCgroup } : {}),
      }),
      [CONTROL_PLANE_ALLOCATION_ID_ENV]: allocationId,
    };
  }

  private async failCreationRoutes(
    allocationId: string,
    retryable: boolean,
    reason: ControlPlaneFailureReason,
    subtype?: ControlPlaneWorkspaceFailureSubtype
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.readAllocation();
      if (state.kind !== 'creating' || state.allocationId !== allocationId) return;
      if (!retryable) {
        for (const route of await listRoutes(this.db)) {
          if (route.state === 'preparing') {
            await failCurrentAttempt(
              this.routeContext(state),
              route.sessionId,
              route.attemptId,
              reason,
              'create_failed',
              subtype
            );
          }
        }
        if (state.providerRef !== null) {
          await this.applyEvent({ type: 'stop-requested', at: Date.now(), reason });
          return;
        }
      }
      await this.applyEvent({
        type: 'create-failed',
        at: Date.now(),
        allocationId,
        nextAllocationId: crypto.randomUUID(),
        retryAllowed: retryable && (await this.retryAllowed()),
      });
    });
  }

  private createProviderAdapter(pin: StoredProviderPin): ProviderAdapter {
    const allocationName = pin.allocationName ?? this.sandboxId;
    switch (pin.provider) {
      case 'vercel': {
        const resources =
          pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
        if (pin.byoc) {
          return createByocVercelProviderAdapter({
            env: this.env,
            source: pin.byoc,
            sandboxName: allocationName,
            resources,
            locator: pin.locator,
            persistRuntimeLocator: locator =>
              this.enqueue(async () => {
                if (
                  this.providerPin?.allocationName !== allocationName ||
                  JSON.stringify(this.providerPin.byoc) !== JSON.stringify(pin.byoc)
                ) {
                  throw new Error('Vercel allocation changed during runtime resolution');
                }
                const resolved = { ...this.providerPin, locator };
                await this.writeProviderPin(resolved);
                this.providerPin = resolved;
              }),
            // Authoritative live grants: read at create and on every credential
            // refresh, never frozen into the adapter at construction.
            readContainedGrants: () => this.activeGrants(Date.now()),
            readAcceptedRuntimeProxyHandles: () =>
              listAcceptedHandleStringsByScopeId(this.ctx.storage, Date.now()),
          });
        }
        return unavailableVercelProviderAdapter();
      }
      case 'cloudflare-containers': {
        const instance =
          pin.configuration?.provider === 'cloudflare-containers'
            ? pin.configuration.instance
            : undefined;
        return createCloudflareContainersProviderAdapter({
          logicalSandboxId: this.sandboxId,
          allocationName,
          ...(instance === undefined ? {} : { instance }),
          ...(pin.egressAllowlist === undefined ? {} : { egressAllowlist: pin.egressAllowlist }),
          ...(pin.egressAudit === true ? { egressAudit: true } : {}),
          getContainer: id => this.env.SANDBOX_CONTAINERS.getByName(id),
        });
      }
      case 'cloudflare':
        return createRetiredCloudflareProviderAdapter();
      default: {
        void (pin.provider satisfies never);
        throw new ProviderCreationError('invalid_configuration');
      }
    }
  }

  private async retryAllowed(): Promise<boolean> {
    return routeRetryAllowed(this.routeContext(await this.readAllocation()));
  }

  private async readAllocation(): Promise<AllocationState> {
    const row = await this.readAllocationRow();
    return row === null ? initialAllocationState() : rowToState(row);
  }

  private async readAllocationRow(): Promise<AllocationRow | null> {
    const rows = await this.db
      .select()
      .from(allocationTable)
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
    return rows[0] ?? null;
  }

  private async writeAllocation(state: AllocationState, previous?: AllocationState): Promise<void> {
    const row = stateToRow(state);
    this.db.transaction(tx => {
      tx.insert(allocationTable)
        .values(row)
        .onConflictDoUpdate({ target: allocationTable.id, set: row })
        .run();
      if (previous !== undefined && previous.allocationId !== state.allocationId) {
        resetRuntimeContract(this.ctx.storage.kv, state.allocationId);
        resetRuntimeIdentity(this.ctx.storage.kv);
      }
    });
    if (
      previous?.kind === state.kind &&
      previous.lastActivityAt === state.lastActivityAt &&
      previous.unconfirmedProviderRef === state.unconfirmedProviderRef
    )
      return;
    this.broadcastStatusSnapshots(state);
  }

  private broadcastStatusSnapshots(state: AllocationState): void {
    for (const socket of this.ctx.getWebSockets('sandbox-status')) {
      const attachment: unknown = socket.deserializeAttachment();
      if (
        typeof attachment === 'object' &&
        attachment !== null &&
        'sessionId' in attachment &&
        typeof attachment.sessionId === 'string'
      ) {
        const identity = workspaceSnapshotIdentitySchema.safeParse(
          'identity' in attachment ? attachment.identity : null
        );
        this.sendStatusSnapshot(
          socket,
          attachment.sessionId,
          state,
          identity.success ? identity.data : null
        );
      }
    }
  }

  private sendStatusSnapshot(
    socket: WebSocket,
    sessionId: string,
    state: AllocationState,
    identity: WorkspaceSnapshotIdentity | null
  ): void {
    const snapshot = {
      ...projectAllocationStatusSnapshot({
        allocation: {
          ...state,
          provider: this.currentProvider(),
          configuration: this.providerPin?.configuration ?? null,
        },
        observedAt: Date.now(),
        inactivityTimeoutMs: this.sandboxIdleTimeoutMs(state),
        runtimeIdentity: readRuntimeIdentity(this.ctx.storage.kv, state.allocationId),
      }),
      ...workspaceSnapshotStatus(this.db, identity),
    };
    try {
      socket.send(
        JSON.stringify({
          eventId: 0,
          executionId: '',
          sessionId,
          streamEventType: 'cloud.sandbox.status',
          timestamp: new Date(snapshot.observedAt).toISOString(),
          data: snapshot,
        })
      );
    } catch {
      socket.close(1011, 'Status delivery failed');
    }
  }

  private isStatusSocket(socket: WebSocket): boolean {
    const attachment: unknown = socket.deserializeAttachment();
    return (
      typeof attachment === 'object' &&
      attachment !== null &&
      'kind' in attachment &&
      attachment.kind === 'sandbox-status'
    );
  }

  private async readProviderPin(): Promise<StoredProviderPin | null> {
    const rows = await this.db
      .select({ pin: allocationTable.provider_pin })
      .from(allocationTable)
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
    const raw = rows[0]?.pin;
    if (typeof raw !== 'string') return null;
    let pin: StoredProviderPin;
    try {
      pin = JSON.parse(raw) as StoredProviderPin;
    } catch {
      return null;
    }
    if (!z.boolean().optional().safeParse(pin.egressAudit).success) {
      throw new ProviderCreationError('invalid_configuration');
    }
    if (pin.egressAllowlist !== undefined) {
      pin.egressAllowlist = nativeEgressAllowlistSchema.parse(pin.egressAllowlist);
    }
    if (pin.egressAllowlist !== undefined || pin.egressAudit === true) {
      if (
        pin.provider !== 'cloudflare-containers' ||
        (pin.sandboxKind === undefined
          ? !this.sandboxId.startsWith('ses-')
          : pin.sandboxKind !== 'isolated')
      ) {
        throw new ProviderCreationError('invalid_configuration');
      }
    }
    return pin;
  }

  private async writeProviderPin(pin: StoredProviderPin): Promise<void> {
    await this.db
      .update(allocationTable)
      .set({ provider_pin: JSON.stringify(pin) })
      .where(eq(allocationTable.id, ALLOCATION_ROW_ID));
  }

  private async armAlarm(state: AllocationState): Promise<void> {
    // The one alarm is the earliest of the allocation timers and the route
    // preparation deadlines, so a hung wrapper's route cannot outlive its
    // preparation attempt.
    const allocationAt = nextAllocationAlarmAt(state, this.sandboxTimers());
    const routeAt = await earliestRouteDeadlineAt(this.db);
    const renewalAt = nextCredentialRenewalAt(
      await listRoutes(this.db),
      this.sandboxTimers().credentialGrantReissueBelowMs,
      this.credentialRenewalRetryAt
    );
    // Pending work must survive loss of the in-memory launch continuation.
    const retryAt =
      state.kind === 'stopped' &&
      routeAt !== null &&
      (await routeRetryAllowed(this.routeContext(state)))
        ? Date.now() + this.sandboxTimers().providerCreateRetryMs
        : null;
    const disk = readWorkspaceSnapshotAllocation(this.db);
    const snapshotRoutes = disk === undefined ? [] : liveWorkspaceRoutes(await listRoutes(this.db));
    const snapshotSocket = this.boundWrapperSocket(state);
    let snapshotAt: number | null = null;
    let snapshotReason: string;
    if (this.provider.workspaceSnapshots === undefined) snapshotReason = 'unsupported_provider';
    else if (this.workspaceSnapshotCapturePending) snapshotReason = 'capture_pending';
    else if (this.pendingControlRequests.size !== 0) snapshotReason = 'control_pending';
    else if (state.kind !== 'connected') snapshotReason = 'not_connected';
    else if (state.lastActivityAt === null) snapshotReason = 'no_activity';
    else if (disk === undefined) snapshotReason = 'untracked';
    else if (disk.allocationId !== state.allocationId) snapshotReason = 'allocation_mismatch';
    else if (disk.idleConnectionId !== state.connectionId)
      snapshotReason = 'idle_connection_mismatch';
    else if (snapshotRoutes.length === 0) snapshotReason = 'no_routes';
    else if (snapshotRoutes.some(route => route.state !== 'ready'))
      snapshotReason = 'route_not_ready';
    else if (
      !workspaceSnapshotRoutesEligible(snapshotRoutes, route =>
        this.workspaceSnapshotRouteEligible(route)
      )
    )
      snapshotReason = 'route_ineligible';
    else if (snapshotSocket === null) snapshotReason = 'no_socket';
    else if (this.readAttachment(snapshotSocket)?.workspaceSnapshots !== true)
      snapshotReason = 'not_capable';
    else if (disk.attemptedIdleAt === workspaceSnapshotIdleAt(state, disk))
      snapshotReason = 'already_attempted';
    else {
      snapshotReason = 'scheduled';
      snapshotAt = workspaceSnapshotIdleAt(state, disk) + this.workspaceSnapshotIdleMs;
    }
    logControlDiagnostic(
      'workspace_snapshot_schedule',
      {
        sandboxId: this.sandboxId,
        workspaceId: disk?.owner.workspaceId,
        allocationId: state.allocationId,
        reason: snapshotReason,
        snapshotAt,
      },
      'info',
      { coalesceIdentity: `workspace_snapshot_schedule:${this.sandboxId}` }
    );
    const candidates = [
      allocationAt,
      routeAt,
      renewalAt,
      retryAt,
      snapshotAt,
      this.earliestHelloDeadlineAt(),
    ].filter((at): at is number => at !== null);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private sandboxTimers(): SandboxTimers {
    return resolveControlPlaneTimers(this.env as unknown as Record<string, string | undefined>)
      .sandbox;
  }

  /**
   * Bounds the stored-policy read inside the wrapper's heartbeat
   * acknowledgement deadline. The read runs on the serial queue, so a read that
   * outlived the deadline would hold back the acknowledgement the wrapper
   * watchdog waits for and reconnect a healthy socket. Half the deadline leaves
   * room for the queued acknowledgement itself; a timed-out read stays
   * non-enforcing and is retried on the next cadence.
   */
  private billingReadTimeoutMs(): number {
    const timers = resolveControlPlaneTimers(
      this.env as unknown as Record<string, string | undefined>
    );
    return Math.max(
      1,
      Math.min(
        timers.sandbox.providerStopAttemptMs,
        Math.floor(timers.wrapper.heartbeatAckTimeoutMs / 2)
      )
    );
  }

  /**
   * Derived from the routes table on every lookup, so no route write can leave
   * it stale. SQLite extracts only the origin; an unreadable credential source
   * keeps the longer interactive window.
   */
  private sandboxIdleTimeoutMs(state: AllocationState | null): number {
    const timers = this.sandboxTimers();
    if (state?.kind !== 'connected') return timers.idleMs;
    const source = routesTable.credential_source;
    const routes = this.db
      .select({
        state: routesTable.state,
        readable: sql<number>`coalesce(json_valid(${source}), 1)`,
        origin: sql<unknown>`case when json_valid(${source}) then json_extract(${source}, '$.createdOnPlatform') end`,
      })
      .from(routesTable)
      .all();
    return routes.some(route => route.state === 'preparing' || route.readable === 0) ||
      sandboxIdlePolicyForOrigins(routes.map(route => route.origin)) === 'interactive'
      ? timers.idleMs
      : timers.unattendedIdleMs;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.operations.tail.then(task, task);
    this.operations.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
