import 'server-only';
import {
  createTRPCClient,
  httpLink,
  httpSubscriptionLink,
  splitLink,
  TRPCClientError,
} from '@trpc/client';
import { TRPCError } from '@trpc/server';
// @ts-expect-error - event-source-polyfill doesn't have types
import { EventSourcePolyfill } from 'event-source-polyfill';
import type { StreamEvent } from '@/components/cloud-agent/types';
import type { EncryptedEnvelope } from '@/lib/encryption';
import type { Images } from '@/lib/images-schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureException } from '@sentry/nextjs';
import { createNoRetryEventSource } from '@/lib/trpc/noRetryEventSource';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const CLOUD_AGENT_API_URL = getEnvVariable('CLOUD_AGENT_API_URL') || '';

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
 * Type definitions for cloud-agent API procedures
 * These mirror the cloud-agent router types to provide type safety without importing from cloud-agent
 *
 * TODO: Should try and generate shared types from cloud-agent schema?
 */

/** Input for initiateSessionStream procedure */
export type InitiateSessionInput = {
  githubRepo?: string;
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  upstreamBranch?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;
  /**
   * Platform identifier for session creation (e.g., "slack", "cloud-agent").
   * Used to set the session's created_on_platform label.
   * Defaults to "cloud-agent" if not specified.
   */
  createdOnPlatform?: string;
  /** Image attachments for the prompt */
  images?: Images;
};

/** Input for initiateSessionAsync procedure (with callback) */
export type InitiateSessionAsyncInput = InitiateSessionInput & {
  callbackUrl: string;
  callbackHeaders?: Record<string, string>;
};

/** Input for sendMessageStream procedure (V1 - uses sessionId) */
export type SendMessageInput = {
  sessionId: string;
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model: string;
  autoCommit?: boolean;
  githubToken?: string;
  gitToken?: string;
  /** Image attachments for the message */
  images?: Images;
};

/** Input for sendMessageV2 procedure (V2 - uses cloudAgentSessionId) */
export type SendMessageV2Input = {
  cloudAgentSessionId: string;
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
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

/** Input for initiateFromKilocodeSession procedure (legacy mode with full params) */
export type InitiateFromKilocodeSessionLegacyInput = {
  kiloSessionId: string; // UUID of existing cli_session
  githubRepo: string; // Required: org/repo format
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model: string;
  kilocodeOrganizationId?: string;
  githubToken?: string;
  envVars?: Record<string, string>;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  autoCommit?: boolean;
};

/** Input for initiateFromKilocodeSession procedure (new mode with cloudAgentSessionId only) */
export type InitiateFromPreparedSessionInput = {
  cloudAgentSessionId: string;
  kilocodeOrganizationId?: string;
  githubToken?: string;
};

/** Combined input for initiateFromKilocodeSession (supports both modes) */
export type InitiateFromKilocodeSessionInput =
  | InitiateFromKilocodeSessionLegacyInput
  | InitiateFromPreparedSessionInput;

/** Input for prepareSession procedure */
export type PrepareSessionInput = {
  prompt: string;
  mode: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model: string;
  // GitHub-specific params
  githubRepo?: string;
  /** @deprecated Use githubInstallationId instead - cloud-agent now generates tokens */
  githubToken?: string;
  /** GitHub App installation ID for token generation in cloud-agent */
  githubInstallationId?: string;
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
  /** Custom text to append to the system prompt */
  appendSystemPrompt?: string;
  /** Image attachments for the prompt */
  images?: Images;
  /** Callback configuration for execution completion events */
  callbackTarget?: {
    url: string;
    headers?: Record<string, string>;
  };
};

/** Output from prepareSession procedure */
export type PrepareSessionOutput = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
};

/** Input for prepareLegacySession procedure */
export type PrepareLegacySessionInput = PrepareSessionInput & {
  cloudAgentSessionId: string;
  kiloSessionId: string;
};

/** Output from prepareLegacySession procedure */
export type PrepareLegacySessionOutput = PrepareSessionOutput;

/** Input for getSession procedure */
export type GetSessionInput = {
  cloudAgentSessionId: string;
};

/** Execution state from cloud-agent DO */
export type ExecutionState = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt?: number;
  lastHeartbeat?: number;
  processId?: string | null;
  error?: string | null;
  health?: 'healthy' | 'stale' | 'unknown';
};

/** Output from getSession procedure (sanitized, no secrets) */
export type GetSessionOutput = {
  // Session identifiers
  sessionId: string;
  kiloSessionId?: string;
  userId: string;
  orgId?: string;
  sandboxId?: string;

  // Repository info (no tokens)
  githubRepo?: string;
  gitUrl?: string;

  // Execution params
  prompt?: string;
  mode?: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model?: string;
  autoCommit?: boolean;
  condenseOnComplete?: boolean;
  upstreamBranch?: string;

  // Configuration metadata (counts only, no values)
  envVarCount?: number;
  setupCommandCount?: number;
  mcpServerCount?: number;

  // Current execution state (null if no execution in flight)
  execution?: ExecutionState | null;
  queuedCount?: number;

  // Lifecycle timestamps (critical for idempotency)
  preparedAt?: number;
  initiatedAt?: number;

  // Versioning
  timestamp: number;
  version: number;
};

/** Output from health procedure */
export type HealthOutput = {
  status: string;
  timestamp: string;
  version: string;
};

/** Output from V2 mutation procedures (WebSocket-based) */
export type InitiateSessionV2Output = {
  cloudAgentSessionId: string;
  executionId: string;
  status: 'queued' | 'started';
  streamUrl: string;
};

/** Result of interrupting a session */
export type InterruptResult = {
  success: boolean;
  killedProcessIds: string[];
  failedProcessIds: string[];
  message: string;
};

/**
 * Custom error class for payment-related errors from cloud-agent.
 * This allows the tRPC router to properly re-throw with PAYMENT_REQUIRED code.
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
 * This preserves the 402 status through the tRPC stack.
 * Used by cloud-agent routers to properly propagate payment errors.
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
 * When EventSource receives a non-2xx response, the HTTP status is nested
 * inside the TRPCClientError's cause property as a SuppressedError.
 */
function isInsufficientCreditsError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    // Check for 402 HTTP status code in standard tRPC error data
    const httpStatus = err.data?.httpStatus || err.shape?.data?.httpStatus;
    if (httpStatus === 402) {
      return true;
    }

    // When EventSource fails to connect due to non-2xx response,
    // the status is nested in cause.error.status or cause.suppressed.status
    const cause = err.cause as { error?: { status?: number }; suppressed?: { status?: number } };
    if (cause?.error?.status === 402 || cause?.suppressed?.status === 402) {
      return true;
    }
  }
  return false;
}

/**
 * Minimal TRPC client interface for cloud-agent API
 * Defines only the procedures we actually use
 */
interface CloudAgentTRPCClient {
  initiateSessionStream: {
    subscribe: <TInput>(
      input: TInput,
      callbacks: {
        onData: (data: StreamEvent) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      }
    ) => { unsubscribe: () => void };
  };
  initiateSessionAsync: {
    subscribe: <TInput>(
      input: TInput,
      callbacks: {
        onData: (data: StreamEvent) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      }
    ) => { unsubscribe: () => void };
  };
  initiateFromKilocodeSession: {
    subscribe: <TInput>(
      input: TInput,
      callbacks: {
        onData: (data: StreamEvent) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      }
    ) => { unsubscribe: () => void };
  };
  sendMessageStream: {
    subscribe: <TInput>(
      input: TInput,
      callbacks: {
        onData: (data: StreamEvent) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      }
    ) => { unsubscribe: () => void };
  };
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
    query: (input: { cloudAgentSessionId: string }) => Promise<GetSessionOutput>;
  };
  prepareSession: {
    mutate: (input: PrepareSessionInput) => Promise<PrepareSessionOutput>;
  };
  prepareLegacySession: {
    mutate: (input: PrepareLegacySessionInput) => Promise<PrepareLegacySessionOutput>;
  };
  // V2 mutation-based procedures (WebSocket streaming)
  initiateFromKilocodeSessionV2: {
    mutate: (input: InitiateFromKilocodeSessionInput) => Promise<InitiateSessionV2Output>;
  };
  sendMessageV2: {
    mutate: (input: SendMessageV2Input) => Promise<InitiateSessionV2Output>;
  };
}

/**
 * Options for configuring the cloud agent client
 */
export type CloudAgentClientOptions = {
  /**
   * Skip balance validation in cloud-agent (used by App Builder which handles its own billing).
   * When true, the x-skip-balance-check header is sent with subscription requests.
   *
   * Note that this should NEVER be exposed in frontend/client side code.
   */
  skipBalanceCheck?: boolean;
};

/**
 * Client for communicating with the cloud agent TRPC API
 * Handles authentication and request forwarding to the remote cloud agent service
 *
 * Uses EventSourcePolyfill to support custom headers (Authorization) in SSE connections,
 * which standard EventSource does not support.
 */
export class CloudAgentClient {
  private client: CloudAgentTRPCClient;
  private authToken: string;
  private options: CloudAgentClientOptions;

  constructor(authToken: string, options: CloudAgentClientOptions = {}) {
    this.authToken = authToken;
    this.options = options;
    const NoRetryEventSource = createNoRetryEventSource(EventSourcePolyfill as typeof EventSource);

    // Build common headers for both subscriptions and mutations
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
    };
    if (this.options.skipBalanceCheck) {
      baseHeaders['x-skip-balance-check'] = 'true';
    }

    // Create TRPC client with proper subscription support
    // Uses splitLink to route subscriptions through httpSubscriptionLink
    // and queries/mutations through httpBatchLink
    this.client = createTRPCClient({
      links: [
        splitLink({
          condition: op => op.type === 'subscription',
          // Subscriptions: Use httpSubscriptionLink with EventSourcePolyfill for auth headers
          true: httpSubscriptionLink({
            url: `${CLOUD_AGENT_API_URL}/trpc`,
            // Use EventSourcePolyfill to support Authorization headers
            // Standard EventSource doesn't support custom headers
            EventSource: NoRetryEventSource,
            eventSourceOptions: _opts =>
              ({
                headers: baseHeaders,
                // Set heartbeat timeout to match cloud-agent setup timeout (120s) + 5s.
                heartbeatTimeout: 125000,
              }) as EventSourceInit,
          }),
          // Queries/Mutations: Use httpLink (not httpBatchLink) so cloud-agent can parse input directly
          false: httpLink({
            url: `${CLOUD_AGENT_API_URL}/trpc`,
            headers: () => ({
              ...baseHeaders,
              // Required for prepareSession/getSession endpoints that use internalApiProtectedProcedure
              'x-internal-api-key': INTERNAL_API_SECRET,
            }),
          }),
        }),
      ],
    }) as unknown as CloudAgentTRPCClient;
  }

  /**
   * Get the underlying TRPC client for direct access to procedures
   */
  getClient(): unknown {
    return this.client;
  }

  /**
   * Bridge TRPC subscription to async generator pattern
   * Handles the promise-based queue and subscription lifecycle
   */
  private async *subscriptionToAsyncGenerator<TInput>(
    procedureName:
      | 'initiateSessionStream'
      | 'initiateSessionAsync'
      | 'initiateFromKilocodeSession'
      | 'sendMessageStream',
    input: TInput,
    endpoint: string
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const eventQueue: StreamEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let rejectNext: ((error: Error) => void) | null = null;
    let subscription: { unsubscribe: () => void } | null = null;
    let done = false;
    let error: Error | null = null;

    try {
      subscription = this.client[procedureName].subscribe(input, {
        onData: (data: StreamEvent) => {
          eventQueue.push(data);
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
            rejectNext = null;
          }
        },
        onError: (err: unknown) => {
          captureException(err, {
            tags: { source: 'cloud-agent-client', endpoint },
            extra: { input },
          });
          // Check if this is an insufficient credits error and wrap appropriately
          if (isInsufficientCreditsError(err)) {
            error = new InsufficientCreditsError();
          } else {
            error = err instanceof Error ? err : new Error(String(err));
          }
          done = true;
          if (rejectNext) {
            rejectNext(error);
            resolveNext = null;
            rejectNext = null;
          }
        },
        onComplete: () => {
          done = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
            rejectNext = null;
          }
        },
      });

      // Yield events as they arrive
      while (!done || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (event) {
            yield event;
          }
        } else if (!done) {
          // Wait for next event
          await new Promise<void>((resolve, reject) => {
            resolveNext = resolve;
            rejectNext = reject;
          });
        }
      }

      // If we exited due to error, throw it
      if (error !== null) {
        const errorToThrow: Error = error;
        throw errorToThrow;
      }
    } finally {
      subscription?.unsubscribe();
    }
  }

  /**
   * Initiate a new session with streaming output
   * Uses TRPC subscription with EventSourcePolyfill for auth header support
   */
  async *initiateSessionStream(
    input: InitiateSessionInput
  ): AsyncGenerator<StreamEvent, void, unknown> {
    yield* this.subscriptionToAsyncGenerator(
      'initiateSessionStream',
      input,
      'initiateSessionStream'
    );
  }

  /**
   * Initiate a session from an existing Kilocode CLI session with streaming output
   * Uses TRPC subscription with EventSourcePolyfill for auth header support
   */
  async *initiateFromKilocodeSession(
    input: InitiateFromKilocodeSessionInput
  ): AsyncGenerator<StreamEvent, void, unknown> {
    yield* this.subscriptionToAsyncGenerator(
      'initiateFromKilocodeSession',
      input,
      'initiateFromKilocodeSession'
    );
  }

  /**
   * Initiate a new session with callback notification (fire-and-forget)
   * Uses TRPC subscription with EventSourcePolyfill for auth header support
   * Returns only the sessionId, then disconnects. Cloud Agent will call back when complete.
   */
  async *initiateSessionAsync(
    input: InitiateSessionAsyncInput
  ): AsyncGenerator<StreamEvent, void, unknown> {
    yield* this.subscriptionToAsyncGenerator('initiateSessionAsync', input, 'initiateSessionAsync');
  }

  /**
   * Send a message to an existing session with streaming output
   * Uses TRPC subscription with EventSourcePolyfill for auth header support
   */
  async *sendMessageStream(input: SendMessageInput): AsyncGenerator<StreamEvent, void, unknown> {
    yield* this.subscriptionToAsyncGenerator('sendMessageStream', input, 'sendMessageStream');
  }

  /**
   * Check health status of the cloud agent API
   */
  async health(): Promise<HealthOutput> {
    try {
      return await this.client.health.query();
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'health' },
      });
      throw error;
    }
  }

  /**
   * Delete a session from the cloud agent.
   *
   * @param sessionId - The session ID to delete
   * @returns Promise resolving to success status (always returns, never throws)
   */
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      const result = await this.client.deleteSession.mutate({ sessionId });
      return { success: result.success };
    } catch (error) {
      // Log errors but don't throw - graceful degradation
      console.error(`Error deleting session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'deleteSession' },
        extra: { sessionId },
      });
      return { success: false };
    }
  }

  /**
   * Interrupt a running session by killing all associated kilocode processes.
   *
   * This allows clients to stop running executions in a session without
   * deleting the session itself. Useful for canceling long-running or stuck operations.
   *
   * @param sessionId - The session ID to interrupt
   * @returns Promise resolving to interrupt result with lists of killed/failed process IDs
   */
  async interruptSession(sessionId: string): Promise<InterruptResult> {
    try {
      const result = await this.client.interruptSession.mutate({ sessionId });
      return result;
    } catch (error) {
      console.error(`Error interrupting session ${sessionId}:`, error);
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'interruptSession' },
        extra: { sessionId },
      });
      throw error;
    }
  }

  /**
   * Get session state from cloud-agent DO.
   *
   * Returns sanitized session metadata including lifecycle timestamps
   * (preparedAt, initiatedAt) for idempotency checks. Excludes secrets
   * like tokens and environment variable values.
   *
   * @param cloudAgentSessionId - The cloud-agent session ID to retrieve
   * @returns Promise resolving to sanitized session metadata
   * @throws Error if session not found or other errors occur
   */
  async getSession(cloudAgentSessionId: string): Promise<GetSessionOutput> {
    try {
      return await this.client.getSession.query({ cloudAgentSessionId });
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'getSession' },
        extra: { cloudAgentSessionId },
      });
      throw error;
    }
  }

  /**
   * Prepare a new cloud agent session.
   *
   * This creates a cliSession in kilocode-backend and stores the session
   * params in the cloud-agent DO. The session is in "prepared" state and
   * ready for execution via initiateFromKilocodeSession.
   *
   * @param input - Session configuration including repo, prompt, mode, model
   * @returns Promise resolving to { kiloSessionId, cloudAgentSessionId }
   * @throws Error if session preparation fails
   */
  async prepareSession(input: PrepareSessionInput): Promise<PrepareSessionOutput> {
    try {
      return await this.client.prepareSession.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'prepareSession' },
        extra: { input },
      });
      throw error;
    }
  }

  /**
   * Prepare an existing cloud agent session using a pre-existing CLI session.
   *
   * This stores session params in the DO without creating a new cliSession.
   */
  async prepareLegacySession(
    input: PrepareLegacySessionInput
  ): Promise<PrepareLegacySessionOutput> {
    try {
      return await this.client.prepareLegacySession.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'prepareLegacySession' },
        extra: { input },
      });
      throw error;
    }
  }

  /**
   * Initiate a session from an existing Kilocode CLI session using the V2 WebSocket-based API.
   *
   * Unlike the V1 streaming methods, this returns immediately with execution info
   * and a WebSocket URL for streaming. The client connects to the streamUrl
   * separately to receive events.
   *
   * Supports two modes:
   * - Legacy: { kiloSessionId, githubRepo, prompt, mode, model, ... } for CLI sessions
   * - New: { cloudAgentSessionId } for prepared sessions (after prepareSession)
   *
   * @param input - Session input (legacy or prepared format)
   * @returns Promise resolving to execution info with WebSocket streamUrl
   * @throws Error if session initiation fails
   */
  async initiateFromKilocodeSessionV2(
    input: InitiateFromKilocodeSessionInput
  ): Promise<InitiateSessionV2Output> {
    try {
      return await this.client.initiateFromKilocodeSessionV2.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'initiateFromKilocodeSessionV2' },
        extra: { input },
      });
      throw error;
    }
  }

  /**
   * Send a message to an existing session using the V2 WebSocket-based API.
   *
   * Unlike the V1 streaming methods, this returns immediately with execution info
   * and a WebSocket URL for streaming. The client connects to the streamUrl
   * separately to receive events.
   *
   * @param input - Message input including sessionId, prompt, mode, model
   * @returns Promise resolving to execution info with WebSocket streamUrl
   * @throws Error if message sending fails
   */
  async sendMessageV2(input: SendMessageV2Input): Promise<InitiateSessionV2Output> {
    try {
      return await this.client.sendMessageV2.mutate(input);
    } catch (error) {
      captureException(error, {
        tags: { source: 'cloud-agent-client', endpoint: 'sendMessageV2' },
        extra: { input },
      });
      throw error;
    }
  }
}

/**
 * Create a cloud agent client instance with the provided auth token
 * @param authToken - JWT auth token for authentication
 * @param options - Optional configuration (e.g., skipBalanceCheck for App Builder)
 */
export function createCloudAgentClient(
  authToken: string,
  options?: CloudAgentClientOptions
): CloudAgentClient {
  return new CloudAgentClient(authToken, options);
}

/**
 * Create a cloud agent client instance configured for App Builder.
 *
 * App Builder handles billing separately through usage-based pricing, so the normal
 * balance check in cloud-agent is skipped.
 *
 * @param authToken - JWT auth token for authentication
 */
export function createAppBuilderCloudAgentClient(authToken: string): CloudAgentClient {
  return new CloudAgentClient(authToken, {
    skipBalanceCheck: true,
  });
}

export function createCloudChatClient(authToken: string): CloudAgentClient {
  return new CloudAgentClient(authToken, {
    skipBalanceCheck: true,
  });
}
