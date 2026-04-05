import type { ExecutionId, SessionId } from '../types/ids.js';

export function buildWrapperArgs(params: {
  executionId: ExecutionId;
  mode: string;
  promptFile: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  idleTimeoutMs?: number;
  appendSystemPromptFile?: string;
}): string[] {
  const wrapperPath = '/usr/local/bin/kilocode-wrapper.js';
  const args = [
    wrapperPath,
    `--execution-id=${params.executionId}`,
    `--ingest-token=${params.executionId}`,
    `--mode=${params.mode}`,
    `--prompt=${params.promptFile}`,
  ];
  if (params.idleTimeoutMs && Number.isFinite(params.idleTimeoutMs)) {
    args.push(`--idle-timeout=${params.idleTimeoutMs}`);
  }
  if (params.autoCommit) {
    args.push('--auto-commit');
  }
  if (params.condenseOnComplete) {
    args.push('--condense-on-complete');
  }
  if (params.appendSystemPromptFile) {
    args.push(`--append-system-prompt-file=${params.appendSystemPromptFile}`);
  }
  return args;
}

export function buildWrapperEnvBase(params: {
  sessionId: SessionId;
  userId: string;
  orgId?: string;
  kilocodeToken?: string;
  kiloSessionId?: string;
  upstreamBranch?: string;
}): Record<string, string> {
  return {
    SESSION_ID: params.sessionId,
    USER_ID: params.userId,
    ORG_ID: params.orgId ?? '',
    KILOCODE_TOKEN: params.kilocodeToken ?? '',
    KILO_SESSION_ID: params.kiloSessionId ?? '',
    UPSTREAM_BRANCH: params.upstreamBranch ?? '',
  };
}
