import { createAgentSandbox } from '../agent-sandbox/factory.js';
import type { AgentSandbox } from '../agent-sandbox/protocol.js';
import type { WrapperHealthResponse, WrapperPty } from '../kilo/wrapper-client.js';
import type { CloudAgentSessionState, OperationResult } from '../persistence/types.js';
import type { Env } from '../types.js';

const TERMINAL_SESSION_PLATFORMS = new Set(['cloud-agent', 'cloud-agent-web', 'slack']);

export function isTerminalSessionPlatform(platform: string | undefined): boolean {
  return platform !== undefined && TERMINAL_SESSION_PLATFORMS.has(platform);
}

export function validateTerminalMetadata(
  metadata: CloudAgentSessionState | null,
  sessionId: string
): OperationResult<{ metadata: CloudAgentSessionState }> {
  if (!metadata) {
    return { success: false, error: 'Session not found' };
  }

  if (metadata.identity.sessionId !== sessionId) {
    return { success: false, error: 'Invalid terminal session' };
  }

  if (!metadata.lifecycle.preparedAt || !metadata.workspace?.workspacePath) {
    return {
      success: false,
      error: 'Terminal is only available after the workspace is prepared',
    };
  }

  if (!isTerminalSessionPlatform(metadata.identity.createdOnPlatform)) {
    return {
      success: false,
      error: 'Terminal is only available for interactive Cloud Agent sessions',
    };
  }

  return { success: true, data: { metadata } };
}

export type TerminalWrapperClient = {
  health(): Promise<WrapperHealthResponse>;
  createTerminal(size?: { cols: number; rows: number }): Promise<WrapperPty>;
  resizeTerminal(ptyId: string, size: { cols: number; rows: number }): Promise<WrapperPty>;
  closeTerminal(ptyId: string): Promise<{ success: boolean }>;
  connectTerminal(ptyId: string, request: Request): Promise<Response>;
};

type ResolveTerminalWrapperDeps = {
  createSandbox(env: Env, metadata: CloudAgentSessionState): AgentSandbox;
};

const defaultDeps: ResolveTerminalWrapperDeps = {
  createSandbox: createAgentSandbox,
};

export async function resolveTerminalWrapperClient(
  params: {
    env: Env;
    metadata: CloudAgentSessionState | null;
    sessionId: string;
  },
  deps: ResolveTerminalWrapperDeps = defaultDeps
): Promise<OperationResult<{ client: TerminalWrapperClient }>> {
  const metadataResult = validateTerminalMetadata(params.metadata, params.sessionId);
  if (!metadataResult.success || !metadataResult.data) {
    return { success: false, error: metadataResult.error };
  }

  const terminal = await deps
    .createSandbox(params.env, metadataResult.data.metadata)
    .getRunningTerminalClient();
  if (terminal.status === 'not-running') {
    return {
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not running',
    };
  }
  if (terminal.status === 'unhealthy') {
    return {
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not healthy',
    };
  }
  return { success: true, data: { client: terminal.client } };
}
