import 'server-only';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import type { EncryptedEnvelope } from '@/lib/encryption';
import type { Images } from '@/lib/images-schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

/**
 * Cloud Agent Next Client
 *
 * Client for the new cloud-agent-next worker that uses the V2 WebSocket-based API
 * with the new message format (Message + Part[]).
 *
 * PLACEHOLDER: Update CLOUD_AGENT_NEXT_API_URL when the new worker is ready.
 */

// TODO: Update this URL when the new cloud-agent-next worker is deployed
const CLOUD_AGENT_NEXT_API_URL = getEnvVariable('CLOUD_AGENT_NEXT_API_URL') || '';

// MCP server config types (local definition to avoid importing from cloud-agent)
// Supports three transport types: stdio, sse, and streamable-http
type MCPServerBaseConfig = {
  disabled?: boolean;
  timeout?: number;
  alwaysAllow?: string[];
  watchPaths?: string[];
  disabledTools?: string[];
};

type MCPStdioServerConfig = MCPServerBaseConfig & {
  type?: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type MCPSseServerConfig = MCPServerBaseConfig & {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

type MCPStreamableHttpServerConfig = MCPServerBaseConfig & {
  type: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
};

type MCPServerConfig = MCPStdioServerConfig | MCPSseServerConfig | MCPStreamableHttpServerConfig;

/**
 * Type definitions for cloud-agent-next API procedures
 */

/** Callback target configuration for execution completion notifications */
export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

/**
 * Agent modes accepted by the API.
 * - plan, architect, ask: Planning/analysis mode
 * - code, build, orchestrator: Code generation mode
 * - custom: Custom mode (requires appendSystemPrompt)
 */
export type AgentMode = 'plan' | 'code' | 'build' | 'orchestrator' | 'architect' | 'ask' | 'custom';

/** Input for prepareSession procedure */
export type PrepareSessionInput = {
  prompt: string;
  mode: AgentMode;
  model: string;
  // GitHub-specific params
  githubRepo?: string;
  /** GitHub Personal Access Token for private repositories */
  githubToken?: string;
  // Generic git params for GitLab and other providers
  gitUrl?: string;
  gitToken?: string;
  /** Explicit platform type for correct env var setup (avoids URL-based detection) */
  platform?: 'github' | 'gitlab';
  // Common params
  kilocodeOrganizationId?: string;
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  upstreamBranch?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt (required when mode is 'custom') */
  appendSystemPrompt?: string;
  /** Image attachments for the prompt */
  images?: Images;
  /** Callback configuration for execution completion events */
  callbackTarget?: CallbackTarget;
};

/** Output from prepareSession procedure */
export type PrepareSessionOutput = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

/** Input for initiating from a prepared session */
export type InitiateFromPreparedSessionInput = {
  cloudAgentSessionId: string;
  kilocodeOrganizationId?: string;
  githubToken?: string;
};

/** Input for sendMessage procedure (V2 - uses cloudAgentSessionId) */
export type SendMessageInput = {
  cloudAgentSessionId: string;
  prompt: string;
  mode: 'plan' | 'build';
  model: string;
  autoCommit?: boolean;
  githubToken?: string;
  gitToken?: string;
  /** Image attachments for the message */
  images?: Images;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;
};

/** Output from V2 mutation procedures (WebSocket-based) */
export type InitiateSessionOutput = {
  cloudAgentSessionId: string;
  executionId: string;
  status: 'started';
  streamUrl: string;
};

/** Input for getSession procedure */
export type GetSessionInput = {
  cloudAgentSessionId: string;
};

/** Execution status for getSession response */
export type ExecutionStatus = {
  /** Execution ID currently running */
  id: string;
  /** Current status of the execution */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
  /** Timestamp when execution started */
  startedAt: number;
  /** Last heartbeat timestamp from runner (null if never received) */
  lastHeartbeat: number | null;
  /** Sandbox process ID (null if not yet started) */
  processId: string | null;
  /** Error message if execution failed (null if no error) */
  error: string | null;
  /** Health status: healthy (<1min heartbeat), unknown (1-10min), stale (>10min) */
  health: 'healthy' | 'stale' | 'unknown';
} | null;

/** Output from getSession procedure (sanitized, no secrets) */
export type GetSessionOutput = {
  // Session identifiers
  sessionId: string;
  kiloSessionId?: string;
  userId: string;
  orgId?: string;
  /** Sandbox ID (hashed format like usr-abc123...) for correlating with Cloudflare logs */
  sandboxId?: string;

  // Repository info (no tokens)
  githubRepo?: string;
  gitUrl?: string;

  // Execution params
  prompt?: string;
  mode?: AgentMode;
  model?: string;
  autoCommit?: boolean;
  upstreamBranch?: string;

  // Configuration metadata (counts only, no values)
  envVarCount?: number;
  setupCommandCount?: number;
  mcpServerCount?: number;

  // Execution status (grouped for cleaner API)
  execution: ExecutionStatus;

  // Lifecycle timestamps (critical for idempotency)
  preparedAt?: number;
  initiatedAt?: number;

  // Callback configuration (debug-friendly, URL + headers)
  callbackTarget?: CallbackTarget;

  // Versioning
  timestamp: number;
  version: number;
};

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
  // Scalar fields - null to clear, value to set, undefined to skip
  mode?: AgentMode | null;
  model?: string | null;
  githubToken?: string | null;
  gitToken?: string | null;
  upstreamBranch?: string | null;
  autoCommit?: boolean | null;
  condenseOnComplete?: boolean | null;
  appendSystemPrompt?: string | null;
  // Collection fields - empty to clear, value to set, undefined to skip
  envVars?: Record<string, string>;
  encryptedSecrets?: Record<string, EncryptedEnvelope>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  callbackTarget?: CallbackTarget | null;
};

/** Output from updateSession procedure */
export type UpdateSessionOutput = {
  success: boolean;
};

/** Result of interrupting a session */
export type InterruptResult = {
  success: boolean;
  killedProcessIds: string[];
  failedProcessIds: string[];
  message: string;
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

/**
 * Helper to re-throw InsufficientCreditsError as TRPCError with PAYMENT_REQUIRED code.
 */
export function rethrowAsPaymentRequired(error: unknown): never {
  if (error instanceof InsufficientCreditsError) {
    throw new TRPCError({
      code: 'PAYMENT_REQUIRED',
      message: error.message,
    });
  }
  throw error;
}

/**
 * Check if an error indicates insufficient credits (402 Payment Required).
 */
function isInsufficientCreditsError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const httpStatus = err.data?.httpStatus || err.shape?.data?.httpStatus;
    if (httpStatus === 402) {
      return true;
    }
    const cause = err.cause as { error?: { status?: number }; suppressed?: { status?: number } };
    if (cause?.error?.status === 402 || cause?.suppressed?.status === 402) {
      return true;
    }
  }
  return false;
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
  interruptSession: {
    mutate: (input: { sessionId: string }) => Promise<InterruptResult>;
  };
  getSession: {
    query: (input: GetSessionInput) => Promise<GetSessionOutput>;
  };
  prepareSession: {
    mutate: (input: PrepareSessionInput) => Promise<PrepareSessionOutput>;
  };
  updateSession: {
    mutate: (input: UpdateSessionInput) => Promise<UpdateSessionOutput>;
  };
  // V2 mutation-based procedures (WebSocket streaming)
  initiateFromKilocodeSessionV2: {
    mutate: (input: InitiateFromPreparedSessionInput) => Promise<InitiateSessionOutput>;
  };
  sendMessageV2: {
    mutate: (input: SendMessageInput) => Promise<InitiateSessionOutput>;
  };
};

/**
 * Options for configuring the cloud agent client
 */
export type CloudAgentNextClientOptions = {
  /**
   * Skip balance validation in cloud-agent (used by App Builder which handles its own billing).
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

    // Build common headers
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

  /**
   * Get the underlying TRPC client for direct access to procedures
   */
  getClient(): unknown {
    return this.client;
  }

  /**
   * Check health status of the cloud agent API
   */
  async health(): Promise<HealthOutput> {
    try {
      return await this.client.health.query();
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'health' },
      });
      throw error;
    }
  }

  /**
   * Delete a session from the cloud agent.
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      const result = await this.client.deleteSession.mutate({ sessionId });
      return { success: result.success };
    } catch (error) {
      console.error(`Error deleting session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'deleteSession' },
        extra: { sessionId },
      });
      return { success: false };
    }
  }

  /**
   * Interrupt a running session by killing all associated kilocode processes.
   */
  async interruptSession(sessionId: string): Promise<InterruptResult> {
    try {
      const result = await this.client.interruptSession.mutate({ sessionId });
      return result;
    } catch (error) {
      console.error(`Error interrupting session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'interruptSession' },
        extra: { sessionId },
      });
      throw error;
    }
  }

  /**
   * Get session state from cloud-agent DO.
   */
  async getSession(cloudAgentSessionId: string): Promise<GetSessionOutput> {
    try {
      return await this.client.getSession.query({ cloudAgentSessionId });
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'getSession' },
        extra: { cloudAgentSessionId },
      });
      throw error;
    }
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
      console.log('[CloudAgentNextClient.prepareSession] Request failed', {
        elapsed: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });

      // Check for insufficient credits error
      if (isInsufficientCreditsError(error)) {
        throw new InsufficientCreditsError();
      }

      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'prepareSession' },
        extra: { input },
      });
      throw error;
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
    try {
      return await this.client.updateSession.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'updateSession' },
        extra: { cloudAgentSessionId: input.cloudAgentSessionId },
      });
      throw error;
    }
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
      // Check for insufficient credits error
      if (isInsufficientCreditsError(error)) {
        throw new InsufficientCreditsError();
      }

      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'initiateFromPreparedSession' },
        extra: { input },
      });
      throw error;
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
      // Check for insufficient credits error
      if (isInsufficientCreditsError(error)) {
        throw new InsufficientCreditsError();
      }

      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'sendMessage' },
        extra: { input },
      });
      throw error;
    }
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
 * Create a cloud agent next client instance configured for App Builder.
 */
export function createAppBuilderCloudAgentNextClient(authToken: string): CloudAgentNextClient {
  return new CloudAgentNextClient(authToken, {
    skipBalanceCheck: true,
  });
}
