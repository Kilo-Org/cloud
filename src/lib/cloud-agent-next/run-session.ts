import 'server-only';
import { getEnvVariable } from '@/lib/dotenvx';
import { signStreamTicket, type StreamTicketPayload } from '@/lib/cloud-agent/stream-ticket';
import { createWebSocketManager } from './websocket-manager';
import { createEventProcessor, type ProcessedMessage } from './processor';
import type { CloudAgentEvent, StreamError } from './event-types';
import type { CloudAgentNextClient } from './cloud-agent-client';
import type { PrepareSessionInput, InitiateFromPreparedSessionInput } from './cloud-agent-client';

/**
 * Server-side helper for running a cloud-agent-next session to completion.
 *
 * Encapsulates the full lifecycle:
 *   prepare → initiate → sign ticket → connect WebSocket → stream events → return result
 *
 * This is the server-side equivalent of the frontend useCloudAgentStream hook,
 * designed for headless consumers like the Slack bot and security agent.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_AGENT_NEXT_WS_URL = getEnvVariable('NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL');
const CLOUD_AGENT_NEXT_API_URL = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');

const DEFAULT_STREAM_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const COMPLETE_GRACE_MS = 1000; // Wait 1s after 'complete' for final events

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a (possibly relative) stream URL returned by initiateFromPreparedSession
 * into an absolute WebSocket URL.
 *
 * Resolution order for the base URL:
 *   1. NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL  (preferred, purpose-built for WS)
 *   2. CLOUD_AGENT_NEXT_API_URL              (fallback, the tRPC API base)
 */
export function resolveStreamUrl(streamUrl: string): string {
  if (!streamUrl) {
    throw new Error('Cloud Agent stream URL is missing');
  }

  let url: URL;
  if (/^(wss?|https?):\/\//i.test(streamUrl)) {
    url = new URL(streamUrl);
  } else {
    const baseUrl = CLOUD_AGENT_NEXT_WS_URL || CLOUD_AGENT_NEXT_API_URL;
    if (!baseUrl) {
      throw new Error(
        'Neither NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL nor CLOUD_AGENT_NEXT_API_URL is configured'
      );
    }
    url = new URL(streamUrl, baseUrl);
  }

  // Upgrade HTTP(S) to WS(S)
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';

  return url.toString();
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

type MessagePart = ProcessedMessage['parts'][number];
type TextMessagePart = Extract<MessagePart, { type: 'text' }>;

function isTextPart(part: MessagePart): part is TextMessagePart {
  return part.type === 'text';
}

/**
 * Extract concatenated text content from a completed message's parts.
 */
export function extractTextFromMessage(message: ProcessedMessage): string {
  return message.parts
    .filter(isTextPart)
    .map(part => part.text ?? '')
    .join('')
    .trim();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input for runSessionToCompletion */
export type RunSessionInput = {
  /** An already-constructed CloudAgentNextClient (caller owns auth / balance-check config). */
  client: CloudAgentNextClient;
  /** Fields forwarded to prepareSession. */
  prepareInput: PrepareSessionInput;
  /** Partial override for initiateFromPreparedSession (e.g. githubToken). */
  initiateInput?: Omit<InitiateFromPreparedSessionInput, 'cloudAgentSessionId'>;
  /** Payload fields for signing the WebSocket stream ticket. */
  ticketPayload: Pick<StreamTicketPayload, 'userId' | 'organizationId'>;
  /** Stream timeout in ms (default: 15 minutes). */
  streamTimeoutMs?: number;
  /** Optional log prefix for console messages (e.g. '[SlackBot]'). */
  logPrefix?: string;
};

/** Result from runSessionToCompletion */
export type RunSessionResult = {
  /** The final text response extracted from the assistant's completed message(s). */
  response: string;
  /** The cloud-agent session ID (available even on failure). */
  sessionId?: string;
  /** Whether the session encountered an error. */
  hasError: boolean;
  /** Collected status/error messages for diagnostics. */
  statusMessages: string[];
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a cloud-agent-next session to completion, returning the final text result.
 *
 * Steps:
 *   1. prepareSession        → cloudAgentSessionId + kiloSessionId
 *   2. initiateFromPrepared  → streamUrl
 *   3. resolveStreamUrl      → absolute wss:// URL
 *   4. signStreamTicket      → short-lived JWT for WebSocket auth
 *   5. EventProcessor + WebSocketManager  → stream events until idle/complete/error
 *   6. Return aggregated text result
 */
export async function runSessionToCompletion(input: RunSessionInput): Promise<RunSessionResult> {
  const {
    client,
    prepareInput,
    initiateInput,
    ticketPayload,
    logPrefix = '[CloudAgentNext]',
  } = input;
  const streamTimeoutMs = input.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const statusMessages: string[] = [];
  let completionResult: string | undefined;
  let sessionId: string | undefined;
  let kiloSessionId: string | undefined;
  let hasError = false;
  let errorMessage: string | undefined;

  // 1. Prepare
  try {
    const prepared = await client.prepareSession(prepareInput);
    sessionId = prepared.cloudAgentSessionId;
    kiloSessionId = prepared.kiloSessionId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Error preparing session:`, msg, error);
    return {
      response: `Error preparing Cloud Agent: ${msg}`,
      sessionId,
      hasError: true,
      statusMessages,
    };
  }

  if (!sessionId || !kiloSessionId) {
    const msg = 'Session preparation did not return session IDs.';
    console.error(`${logPrefix} ${msg}`);
    return { response: msg, sessionId, hasError: true, statusMessages };
  }

  // 2. Initiate
  let streamUrl: string;
  try {
    const initiated = await client.initiateFromPreparedSession({
      cloudAgentSessionId: sessionId,
      ...initiateInput,
    });
    streamUrl = initiated.streamUrl;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Error initiating session:`, msg, error);
    return {
      response: `Error initiating Cloud Agent: ${msg}`,
      sessionId,
      hasError: true,
      statusMessages,
    };
  }

  // 3. Resolve URL
  let wsUrl: string;
  try {
    wsUrl = resolveStreamUrl(streamUrl);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Error resolving stream URL:`, msg, error);
    return {
      response: `Error resolving stream URL: ${msg}`,
      sessionId,
      hasError: true,
      statusMessages,
    };
  }

  // 4. Sign ticket
  const ticketFields: StreamTicketPayload = {
    userId: ticketPayload.userId,
    kiloSessionId,
    cloudAgentSessionId: sessionId,
    organizationId: ticketPayload.organizationId,
  };
  const { ticket } = signStreamTicket(ticketFields);

  // 5. Wire up EventProcessor + WebSocketManager
  let resolveStream: (() => void) | undefined;
  let completeGraceTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let streamCompleted = false;
  const streamTimeoutRef: { id?: ReturnType<typeof setTimeout> } = {};

  const resolveOnce = () => {
    if (streamCompleted) return;
    streamCompleted = true;
    if (streamTimeoutRef.id) clearTimeout(streamTimeoutRef.id);
    if (completeGraceTimeoutId) clearTimeout(completeGraceTimeoutId);
    resolveStream?.();
  };

  const processor = createEventProcessor({
    callbacks: {
      onMessageCompleted: (_sid, _mid, message) => {
        if (message.info.role !== 'assistant') return;
        const text = extractTextFromMessage(message);
        if (text) completionResult = text;

        if (message.info.error) {
          const errData = message.info.error as { data?: { message?: string } };
          hasError = true;
          errorMessage = errData?.data?.message ?? 'Assistant message failed.';
        }
      },
      onSessionStatusChanged: status => {
        if (status.type === 'idle') resolveOnce();
      },
      onError: error => {
        hasError = true;
        errorMessage = error;
        resolveOnce();
      },
    },
  });

  const streamDone = new Promise<void>(resolve => {
    resolveStream = resolve;
  });

  const scheduleCompleteGrace = () => {
    if (completeGraceTimeoutId) return;
    completeGraceTimeoutId = setTimeout(resolveOnce, COMPLETE_GRACE_MS);
  };

  const wsManager = createWebSocketManager({
    url: wsUrl,
    ticket,
    onEvent: (event: CloudAgentEvent) => {
      processor.processEvent(event);

      switch (event.streamEventType) {
        case 'complete': {
          const data = event.data as { exitCode?: number; metadata?: { executionTimeMs?: number } };
          statusMessages.push(
            `Session completed${data?.metadata?.executionTimeMs !== undefined ? ` in ${data.metadata.executionTimeMs}ms` : ''} with exit code ${data?.exitCode ?? 'unknown'}`
          );
          scheduleCompleteGrace();
          break;
        }
        case 'error': {
          const data = event.data as { error?: string };
          const text = data?.error ?? 'Cloud Agent error';
          statusMessages.push(`Error: ${text}`);
          hasError = true;
          errorMessage = text;
          resolveOnce();
          break;
        }
        case 'interrupted': {
          const data = event.data as { reason?: string };
          const reason = data?.reason ?? 'Session interrupted';
          statusMessages.push(`Session interrupted: ${reason}`);
          hasError = true;
          errorMessage = reason;
          resolveOnce();
          break;
        }
        case 'output': {
          const data = event.data as { source?: string; content?: string };
          if (data?.source === 'stderr') {
            statusMessages.push(`[stderr] ${data.content ?? ''}`.trim());
            hasError = true;
          }
          break;
        }
        case 'status': {
          const data = event.data as { message?: string };
          if (data?.message) statusMessages.push(data.message);
          break;
        }
      }
    },
    onStateChange: state => {
      if (state.status === 'error') {
        hasError = true;
        errorMessage = state.error;
        resolveOnce();
      }
      if (state.status === 'disconnected') {
        resolveOnce();
      }
    },
    onError: (error: StreamError) => {
      hasError = true;
      errorMessage = `${error.code}: ${error.message}`;
      resolveOnce();
    },
    onRefreshTicket: async () => {
      const refreshed = signStreamTicket(ticketFields);
      return refreshed.ticket;
    },
  });

  // 6. Stream
  console.log(`${logPrefix} Connecting to stream for session ${sessionId}...`);
  wsManager.connect();

  streamTimeoutRef.id = setTimeout(() => {
    hasError = true;
    errorMessage = `Stream timed out after ${streamTimeoutMs}ms`;
    resolveOnce();
  }, streamTimeoutMs);

  await streamDone;
  wsManager.disconnect();

  console.log(
    `${logPrefix} Stream completed. statusMessages=${statusMessages.length}, hasResult=${!!completionResult}`
  );

  // 7. Build result
  if (hasError) {
    const details = [errorMessage, ...statusMessages].filter(Boolean).join('\n');
    return {
      response: `Cloud Agent session ${sessionId} encountered errors:\n${details}`,
      sessionId,
      hasError: true,
      statusMessages,
    };
  }

  if (completionResult) {
    return {
      response: `Cloud Agent session ${sessionId} completed:\n\n${completionResult}`,
      sessionId,
      hasError: false,
      statusMessages,
    };
  }

  return {
    response: `Cloud Agent session ${sessionId} completed successfully.\n\nStatus:\n${statusMessages.slice(-5).join('\n')}`,
    sessionId,
    hasError: false,
    statusMessages,
  };
}
