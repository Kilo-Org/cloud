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
      platform?: 'github' | 'gitlab';
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
  };
  session: WrapperSessionBinding;
};

export type WrapperCommandRequest = {
  command: string;
  args?: string;
  messageId: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
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
  devcontainer?: WrapperDevContainerMetadata;
};

export type WrapperSessionReadySuccessResponse = {
  status: 'ready';
  kiloSessionId: string;
  workspaceReady: WrapperWorkspaceReady;
};

export type WrapperSessionReadyErrorResponse = {
  status: 'error';
  error: {
    code: 'INVALID_REQUEST' | 'WORKSPACE_SETUP_FAILED' | 'KILO_SERVER_FAILED';
    message: string;
    retryable?: boolean;
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

  return true;
}
