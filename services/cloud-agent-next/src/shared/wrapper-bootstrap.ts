import type { WorkspaceFailureSubtype } from '@kilocode/worker-utils/cloud-agent-failure';

export type { WorkspaceFailureSubtype } from '@kilocode/worker-utils/cloud-agent-failure';

export type WrapperCommitCoAuthor = {
  name: string;
  email: string;
};

export type WrapperBootstrapRepoSource =
  | {
      kind: 'github';
      repo: string;
      token?: string;
      shallow?: boolean;
      gitAuthor?: {
        name: string;
        email: string;
      };
      refreshRemote?: boolean;
    }
  | {
      kind: 'git';
      url: string;
      token?: string;
      platform?: 'github' | 'gitlab' | 'bitbucket';
      shallow?: boolean;
      refreshRemote?: boolean;
    };

export type WrapperBootstrapWorkspace = {
  workspacePath: string;
  sessionHome: string;
  branchName: string;
  upstreamBranch?: string;
  strictBranch?: boolean;
  preferSnapshot?: boolean;
  restoredFromBackup?: boolean;
};

export type WrapperBootstrapRuntimeSkill = {
  name: string;
  rawMarkdown: string;
  files?: Record<string, string>;
};

export type WrapperBootstrapAttachment = {
  filename: string;
  mime: string;
  signedUrl: string;
  localPath: string;
};

export type WrapperBootstrapMaterializedConfig = {
  env: Record<string, string>;
  setupCommands?: string[];
  runtimeSkills?: WrapperBootstrapRuntimeSkill[];
};

export type WrapperDevContainerMetadata = {
  workspacePath: string;
  innerWorkspaceFolder: string;
  wrapperPort: number;
  configPath: string;
};

export type WrapperBootstrapDevContainer = {
  requested: true;
  resolved?: WrapperDevContainerMetadata;
};

export type WrapperSessionBinding = {
  ingestUrl: string;
  ingestToken?: string;
  workerAuthToken: string;
  upstreamBranch?: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

export type WrapperPromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

export type WrapperPromptAgent = {
  mode?: string;
  model?: { providerID?: string; modelID: string };
  variant?: string;
  system?: string;
  tools?: Record<string, boolean>;
};

export type WrapperPromptRequest = {
  message: {
    id: string;
    prompt?: string;
    parts?: WrapperPromptPart[];
    attachments?: WrapperBootstrapAttachment[];
  };
  agent?: WrapperPromptAgent;
  finalization?: {
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
    commitCoAuthor?: WrapperCommitCoAuthor;
  };
  session: WrapperSessionBinding;
};

export type WrapperCommandRequest = {
  command: string;
  args?: string;
  messageId: string;
  agent?: WrapperPromptAgent;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  commitCoAuthor?: WrapperCommitCoAuthor;
  session: WrapperSessionBinding;
};

export type WrapperSessionReadyRequest = {
  agentSessionId: string;
  userId: string;
  orgId?: string;
  sandboxId: string;
  kiloSessionId: string;
  workspace: WrapperBootstrapWorkspace;
  repo?: WrapperBootstrapRepoSource;
  devcontainer?: WrapperBootstrapDevContainer;
  materialized: WrapperBootstrapMaterializedConfig;
  session: WrapperSessionBinding;
  preparation?: {
    attemptId: string;
    triggerMessageId: string;
  };
};

export type WrapperWorkspaceReady = {
  workspacePath: string;
  sandboxId: string;
  sessionHome: string;
  branchName: string;
  kiloSessionId: string;
  githubInstallationId?: string;
  githubAppType?: 'standard' | 'lite';
  gitToken?: string;
  gitlabTokenManaged?: boolean;
  bitbucketTokenManaged?: boolean;
  devcontainer?: WrapperDevContainerMetadata;
};

/**
 * How the repository clone was performed.
 * - `full`: ordinary clone (no partial-clone filter requested), or a blobless
 *   attempt that the remote silently ignored (no rejection, but the filter
 *   never took effect, e.g. no promisor remote configured after clone)
 * - `blobless`: `--filter=blob:none` clone succeeded and was confirmed active
 *   (the remote registered as a promisor remote)
 * - `blobless_fallback`: blobless was rejected by the remote, retried as a full clone
 */
export type WrapperCloneMode = 'full' | 'blobless' | 'blobless_fallback';

export type WrapperCloneTelemetry = {
  mode: WrapperCloneMode;
  /** Clone invocations issued (2 when a blobless attempt fell back). */
  attempts: number;
  /**
   * Whether the blobless attempt's output matched the filter-rejection predicate
   * that triggers the full-clone retry. A blobless clone that fails for a reason
   * the predicate does not recognize reports `false` and gets no retry, so this
   * distinguishes "remote refused the filter" from "clone failed for other reasons".
   */
  filterRejected: boolean;
  durationMs: number;
  repoKind: 'github' | 'git';
  /** `unknown` for a generic git remote that declared no platform. */
  repoPlatform: 'github' | 'gitlab' | 'bitbucket' | 'unknown';
  shallow: boolean;
  /** Size proxies parsed from git's own progress output; absent if git did not report them. */
  totalObjects?: number;
  receivedBytes?: number;
};

/**
 * Non-sensitive bootstrap diagnostics, kept as a sibling of `workspaceReady` rather
 * than a member of it: `workspaceReady` carries `gitToken`, so nesting telemetry there
 * would make the object unsafe to log wholesale. Everything here is safe to log.
 */
export type WrapperBootstrapTelemetry = {
  workspaceWasWarm: boolean;
  /**
   * True when the workspace was populated from an R2 backup rather than
   * genuinely reused from a prior bootstrap. A restored workspace still
   * reports `workspaceWasWarm: true` (the bootstrap marker is included in
   * the backup archive), so this disambiguates "reused as-is" from
   * "restored over the network," which otherwise inflates apparent
   * sandbox-reuse rates.
   */
  restoredFromBackup: boolean;
  clone?: WrapperCloneTelemetry;
};

export type WrapperSessionReadySuccessResponse = {
  status: 'ready';
  kiloSessionId: string;
  workspaceReady: WrapperWorkspaceReady;
  /** Optional: wrappers older than this field's introduction do not send it. */
  telemetry?: WrapperBootstrapTelemetry;
};

export const WRAPPER_READY_ERROR_MESSAGE_MAX_LENGTH = 4_096;
export const WRAPPER_READY_ERROR_DETAIL_MAX_LENGTH = 8_192;

export type WrapperSessionReadyErrorResponse = {
  status: 'error';
  error: {
    code:
      | 'INVALID_REQUEST'
      | 'WRAPPER_FINALIZING'
      | 'WORKSPACE_RECONCILIATION_FAILED'
      | 'WORKSPACE_SETUP_FAILED'
      | 'KILO_SERVER_FAILED';
    subtype?: WorkspaceFailureSubtype;
    message: string;
    detail?: string;
    retryable?: boolean;
    wrapperRunId?: string;
  };
};

export type WrapperSessionReadyResponse =
  | WrapperSessionReadySuccessResponse
  | WrapperSessionReadyErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].length > 0;
}

function isWrapperDevContainerMetadata(value: unknown): value is WrapperDevContainerMetadata {
  if (!isRecord(value)) return false;
  if (!hasString(value, 'workspacePath')) return false;
  if (!hasString(value, 'innerWorkspaceFolder')) return false;
  if (!hasString(value, 'configPath')) return false;
  const wrapperPort = value.wrapperPort;
  return (
    typeof wrapperPort === 'number' &&
    Number.isInteger(wrapperPort) &&
    wrapperPort >= 1 &&
    wrapperPort <= 65535
  );
}

export function isWrapperSessionReadyRequest(value: unknown): value is WrapperSessionReadyRequest {
  if (!isRecord(value)) return false;
  if (!hasString(value, 'agentSessionId')) return false;
  if (!hasString(value, 'userId')) return false;
  if (!hasString(value, 'sandboxId')) return false;
  if (!hasString(value, 'kiloSessionId')) return false;

  const workspace = value.workspace;
  if (!isRecord(workspace)) return false;
  if (!hasString(workspace, 'workspacePath')) return false;
  if (!hasString(workspace, 'sessionHome')) return false;
  if (!hasString(workspace, 'branchName')) return false;
  if (
    workspace.restoredFromBackup !== undefined &&
    typeof workspace.restoredFromBackup !== 'boolean'
  ) {
    return false;
  }

  const devcontainer = value.devcontainer;
  if (devcontainer !== undefined) {
    if (!isRecord(devcontainer) || devcontainer.requested !== true) return false;
    if (
      devcontainer.resolved !== undefined &&
      !isWrapperDevContainerMetadata(devcontainer.resolved)
    ) {
      return false;
    }
  }

  const materialized = value.materialized;
  if (!isRecord(materialized) || !isRecord(materialized.env)) return false;

  const session = value.session;
  if (!isRecord(session)) return false;
  if (!hasString(session, 'ingestUrl')) return false;
  if (!hasString(session, 'workerAuthToken')) return false;
  if (!hasString(session, 'wrapperRunId')) return false;
  if (typeof session.wrapperGeneration !== 'number') return false;
  if (!hasString(session, 'wrapperConnectionId')) return false;

  const preparation = value.preparation;
  if (preparation !== undefined) {
    if (!isRecord(preparation)) return false;
    if (!hasString(preparation, 'attemptId')) return false;
    if (!hasString(preparation, 'triggerMessageId')) return false;
  }

  return true;
}
