import 'server-only';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import type { AgentConfig } from '@kilocode/db/schema-types';
import type { EncryptedEnvelope } from '@/lib/encryption';
import type { Images } from '@/lib/images-schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import type { SendMessagePayload } from './types.js';
export type { SendMessagePayload } from './types.js';

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

/** Input for prepareSession procedure */
export type PrepareSessionInput = {
  prompt: string;
  initialPayload?: SendMessagePayload;
  mode: AgentMode;
  model: string;
  variant?: string;
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
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt (required when mode is 'custom') */
  appendSystemPrompt?: string;
  /** Image attachments for the prompt */
  images?: Images;
  /** Callback configuration for execution completion events */
  callbackTarget?: CallbackTarget;
  /** Platform that created this session (e.g. 'security-agent', 'slack', 'app-builder') */
  createdOnPlatform?: string;
  /** PR gate threshold — when not 'off', the agent reports gateResult in its callback */
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
  /** When true, return immediately and run preparation asynchronously */
  autoInitiate?: boolean;
  /** When true, route the session to a Docker-in-Docker sandbox that supports devcontainer runtimes */
  devcontainer?: boolean;
  initialMessageId?: string | null;
};

/** Output from prepareSession procedure */
export type PrepareSessionOutput = {
  /** The Kilo CLI session ID */
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

/** Input for initiating from a prepared session */
export type InitiateFromPreparedSessionInput = {
  cloudAgentSessionId: string;
};

/** Input for sendMessage procedure (V2 - uses cloudAgentSessionId) */
export type SendMessageInput = {
  cloudAgentSessionId: string;
  payload: SendMessagePayload;
  autoCommit?: boolean;
  githubToken?: string;
  gitToken?: string;
  /** Image attachments for the message */
  images?: Images;
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
  platform?: 'github' | 'gitlab';

  // Execution params
  prompt?: string;
  mode?: AgentMode;
  model?: string;
  autoCommit?: boolean;
  upstreamBranch?: string;

  /** Custom agents stored on this session (slug + name, plus optional model and thinking-effort overrides). */
  runtimeAgents?: Array<{ slug: string; name: string; model?: string; variant?: string }>;

  // Execution status (grouped for cleaner API)
  execution: ExecutionStatus;

  // Lifecycle timestamps (critical for idempotency)
  preparedAt?: number;
  initiatedAt?: number;

  // Callback configuration is intentionally NOT exposed: the stored target
  // may carry service-to-service auth headers (e.g. X-Internal-Secret used
  // by Worker callback ingresses), and getSession is reachable by the
  // session's owning user.

  // Initial message ID for correlation
  initialMessageId?: string;

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
  variant?: string | null;
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
      const normalizedError = normalizeCloudAgentProtocolError(error);

      console.log('[CloudAgentNextClient.prepareSession] Request failed', {
        elapsed: Date.now() - startTime,
        error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      });

      // Check for insufficient credits error
      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'prepareSession' },
        extra: { input },
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
      const normalizedError = normalizeCloudAgentProtocolError(error);

      // Check for insufficient credits error
      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'initiateFromPreparedSession' },
        extra: { input },
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

      // Check for insufficient credits error
      if (isInsufficientCreditsError(normalizedError)) {
        throw new InsufficientCreditsError();
      }

      captureException(normalizedError, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'sendMessage' },
        extra: { input },
      });
      throw normalizedError;
    }
  }

  async createTerminal(input: CreateTerminalInput): Promise<CreateTerminalOutput> {
    try {
      return await this.client.createTerminal.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'createTerminal' },
        extra: { cloudAgentSessionId: input.cloudAgentSessionId },
      });
      throw error;
    }
  }

  async resizeTerminal(input: ResizeTerminalInput): Promise<ResizeTerminalOutput> {
    try {
      return await this.client.resizeTerminal.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'resizeTerminal' },
        extra: { cloudAgentSessionId: input.cloudAgentSessionId, ptyId: input.ptyId },
      });
      throw error;
    }
  }

  async closeTerminal(input: CloseTerminalInput): Promise<CloseTerminalOutput> {
    try {
      return await this.client.closeTerminal.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'closeTerminal' },
        extra: { cloudAgentSessionId: input.cloudAgentSessionId, ptyId: input.ptyId },
      });
      throw error;
    }
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<{ success: boolean }> {
    try {
      return await this.client.answerQuestion.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'answerQuestion' },
        extra: { sessionId: input.sessionId, questionId: input.questionId },
      });
      throw error;
    }
  }

  async rejectQuestion(input: RejectQuestionInput): Promise<{ success: boolean }> {
    try {
      return await this.client.rejectQuestion.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'rejectQuestion' },
        extra: { sessionId: input.sessionId, questionId: input.questionId },
      });
      throw error;
    }
  }

  async answerPermission(input: AnswerPermissionInput): Promise<{ success: boolean }> {
    try {
      return await this.client.answerPermission.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-next-client', endpoint: 'answerPermission' },
        extra: { sessionId: input.sessionId, permissionId: input.permissionId },
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
