import type { CloudAgentSessionState, OperationResult } from '../persistence/types.js';
import { getSandbox } from '@cloudflare/sandbox';
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../core/lease.js';
import {
  WrapperContainerClient,
  type WrapperHealthResponse,
  type WrapperPty,
} from '../kilo/wrapper-client.js';
import { findWrapperForSession } from '../kilo/wrapper-manager.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import type { Env, SandboxId, SandboxInstance } from '../types.js';

const TERMINAL_SESSION_PLATFORMS = new Set(['cloud-agent', 'cloud-agent-web']);

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
  getSandboxInstance(params: { env: Env; sandboxId: SandboxId }): SandboxInstance;
  findWrapperForSession(
    sandbox: SandboxInstance,
    sessionId: string
  ): Promise<{ port: number } | null>;
  createClient(params: { sandbox: SandboxInstance; port: number }): TerminalWrapperClient;
};

const defaultDeps: ResolveTerminalWrapperDeps = {
  getSandboxInstance: ({ env, sandboxId }) =>
    getSandbox(getSandboxNamespace(env, sandboxId), sandboxId, {
      sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS,
    }),
  findWrapperForSession,
  createClient: ({ sandbox, port }) => new WrapperContainerClient({ sandbox, port }),
};

export async function resolveTerminalWrapperClient(
  params: {
    env: Env;
    metadata: CloudAgentSessionState | null;
    sessionId: string;
  },
  deps: ResolveTerminalWrapperDeps = defaultDeps
): Promise<
  OperationResult<{
    client: TerminalWrapperClient;
    sandbox: SandboxInstance;
    sandboxId: SandboxId;
    port: number;
  }>
> {
  const metadataResult = validateTerminalMetadata(params.metadata, params.sessionId);
  if (!metadataResult.success || !metadataResult.data) {
    return { success: false, error: metadataResult.error };
  }

  const { metadata } = metadataResult.data;
  const sandboxId =
    metadata.workspace?.sandboxId ??
    (await generateSandboxId(
      params.env.PER_SESSION_SANDBOX_ORG_IDS,
      metadata.identity.orgId,
      metadata.identity.userId,
      metadata.identity.sessionId,
      metadata.identity.botId
    ));
  const sandbox = deps.getSandboxInstance({ env: params.env, sandboxId });
  const wrapper = await deps.findWrapperForSession(sandbox, metadata.identity.sessionId);

  if (!wrapper) {
    return {
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not running',
    };
  }

  const client = deps.createClient({ sandbox, port: wrapper.port });
  try {
    const health = await client.health();
    if (!health.healthy || health.version !== WRAPPER_VERSION) {
      return {
        success: false,
        error: 'Terminal is unavailable because the session wrapper is not healthy',
      };
    }
  } catch {
    return {
      success: false,
      error: 'Terminal is unavailable because the session wrapper is not healthy',
    };
  }

  return {
    success: true,
    data: {
      client,
      sandbox,
      sandboxId,
      port: wrapper.port,
    },
  };
}
