import 'server-only';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { signStreamTicket, type StreamTicketPayload } from '@/lib/cloud-agent/stream-ticket';
import { createWebSocketManager } from './websocket-manager';
import { createEventProcessor, type ProcessedMessage } from './processor';
import type { CloudAgentEvent, StreamError } from './event-types';
import type { CloudAgentNextClient } from './cloud-agent-client';
import { InsufficientCreditsError } from './cloud-agent-client';
import type { PrepareSessionInput } from './cloud-agent-client';
import { createBoundedStatusLog } from './bounded-status-log';

/**
 * Server-side helper for running a cloud-agent-next session to completion.
 *
 * This is the server-side equivalent of the frontend useCloudAgentStream hook,
 * designed for headless consumers like the Slack bot and security agent.
 */

const CLOUD_AGENT_NEXT_WS_URL = getEnvVariable('NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL');
const CLOUD_AGENT_NEXT_API_URL = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');

const DEFAULT_STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const COMPLETE_GRACE_MS = 1000; // Wait 1s after 'complete' for final events
// The chat surface posts at most 2000 characters of a reply, so the detail
// lines are sized to whatever that leaves after the header, the error text and
// the omitted-line note.
const CHAT_REPLY_MAX_LENGTH = 2000;
const OMITTED_NOTE_RESERVE = 40;

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

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';

  return url.toString();
}

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

/**
 * User-facing reply used on every chat surface when the payer's balance fails
 * the worker-side minimum and no session is started.
 */
export const INSUFFICIENT_CREDITS_RESPONSE =
  'Cannot start a Cloud Agent session: this account or organization has insufficient credits. ' +
  'Add credits in Kilo Code settings and try again.';
/**
 * Keep the newest lines whose joined length fits the budget, oldest first, so a
 * reader who sees only the start of the reply still sees the latest state.
 */
function newestLines(lines: readonly string[], budget: number): readonly string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept;
}

/** Input for runSessionToCompletion */
export type RunSessionInput = {
  /** An already-constructed CloudAgentNextClient (caller owns auth / balance-check config). */
  client: CloudAgentNextClient;
  /** Fields forwarded to prepareSession. */
  prepareInput: PrepareSessionInput;
  /** Payload fields for signing the WebSocket stream ticket. */
  ticketPayload: Pick<StreamTicketPayload, 'userId' | 'organizationId'>;
  /** Stream timeout in ms (default: 15 minutes). */
  streamTimeoutMs?: number;
  /** Optional log prefix for console messages (e.g. '[SlackBot]'). */
  logPrefix?: string;
  /**
   * Called once, right after the session has been prepared and initiated
   * (i.e. the cloud agent is running). Useful for posting early user
   * feedback such as an ephemeral "View Session" link before the session
   * completes. Errors thrown by this callback are logged but do not abort
   * the session.
   */
  onSessionReady?: (info: { cloudAgentSessionId: string; kiloSessionId: string }) => void;
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

/**
 * Run a cloud-agent-next session to completion, returning the final text result.
 */
export async function runSessionToCompletion(input: RunSessionInput): Promise<RunSessionResult> {
  const {
    client,
    prepareInput,
    ticketPayload,
    logPrefix = '[CloudAgentNext]',
    onSessionReady,
  } = input;
  const streamTimeoutMs = input.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const log = createBoundedStatusLog();
  let completionResult: string | undefined;
  let sessionId: string | undefined;
  let kiloSessionId: string | undefined;
  let hasError = false;
  let errorMessage: string | undefined;
  let hasSeenBusy = false;

  try {
    const prepared = await client.prepareSession(prepareInput);
    sessionId = prepared.cloudAgentSessionId;
    kiloSessionId = prepared.kiloSessionId;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      console.error(`${logPrefix} Insufficient credits: session not started`);
      return {
        response: INSUFFICIENT_CREDITS_RESPONSE,
        hasError: true,
        statusMessages: [...log.entries()],
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Error preparing session:`, msg, error);
    return {
      response: `Error preparing Cloud Agent: ${msg}`,
      sessionId,
      hasError: true,
      statusMessages: [...log.entries()],
    };
  }

  if (!sessionId || !kiloSessionId) {
    const msg = 'Session preparation did not return session IDs.';
    console.error(`${logPrefix} ${msg}`);
    return { response: msg, sessionId, hasError: true, statusMessages: [...log.entries()] };
  }

  let streamUrl: string;
  try {
    const initiated = await client.initiateFromPreparedSession({
      cloudAgentSessionId: sessionId,
    });
    streamUrl = initiated.streamUrl;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      console.error(`${logPrefix} Insufficient credits: session not started`);
      // The session record exists at this point; release it promptly with a
      // best-effort cleanup so it does not linger until periodic expiry.
      if (sessionId) {
        void Promise.resolve(client.cleanupSession?.(sessionId)).catch(() => {});
      }
      return {
        response: INSUFFICIENT_CREDITS_RESPONSE,
        sessionId,
        hasError: true,
        statusMessages: [...log.entries()],
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Error initiating session:`, msg, error);
    return {
      response: `Error initiating Cloud Agent: ${msg}`,
      sessionId,
      hasError: true,
      statusMessages: [...log.entries()],
    };
  }

  try {
    onSessionReady?.({ cloudAgentSessionId: sessionId, kiloSessionId });
  } catch (error) {
    console.error(`${logPrefix} onSessionReady callback error:`, error);
  }

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
      statusMessages: [...log.entries()],
    };
  }

  const ticketFields: StreamTicketPayload = {
    userId: ticketPayload.userId,
    kiloSessionId,
    cloudAgentSessionId: sessionId,
    organizationId: ticketPayload.organizationId,
  };
  const { ticket } = signStreamTicket(ticketFields);

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
        if (status.type === 'busy') {
          hasSeenBusy = true;
        }
        if (status.type === 'idle' && hasSeenBusy) {
          resolveOnce();
        }
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
          log.push(
            `Session completed${data?.metadata?.executionTimeMs !== undefined ? ` in ${data.metadata.executionTimeMs}ms` : ''} with exit code ${data?.exitCode ?? 'unknown'}`
          );
          scheduleCompleteGrace();
          break;
        }
        case 'error': {
          const data = event.data as { error?: string };
          const text = data?.error ?? 'Cloud Agent error';
          log.push(`Error: ${text}`);
          hasError = true;
          errorMessage = text;
          resolveOnce();
          break;
        }
        case 'interrupted': {
          const data = event.data as { reason?: string };
          const reason = data?.reason ?? 'Session interrupted';
          log.push(`Session interrupted: ${reason}`);
          hasError = true;
          errorMessage = reason;
          resolveOnce();
          break;
        }
        case 'cloud.message.failed': {
          const data = event.data as { error?: string };
          const text = data?.error ?? 'Queued message delivery failed';
          log.push(`Message failed before execution: ${text}`);
          hasError = true;
          errorMessage = text;
          resolveOnce();
          break;
        }
        case 'output': {
          const data = event.data as { source?: string; content?: string };
          if (data?.source === 'stderr') {
            log.push(`[stderr] ${data.content ?? ''}`.trim());
            hasError = true;
          }
          break;
        }
        case 'status': {
          const data = event.data as { message?: string };
          if (data?.message) log.push(data.message);
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
    `${logPrefix} Stream completed. statusMessages=${log.entries().length}, dropped=${log.droppedCount()}, hasResult=${!!completionResult}`
  );

  const droppedCount = log.droppedCount();
  // The Discord caller keeps only the first ~2000 characters of this reply.
  // Two kinds of line never reach it: the ones the log let go, and the retained
  // ones too old to fit what the reply shows. One note counts both.
  const missingNote = (shown: number) => {
    const missing = droppedCount + log.entries().length - shown;
    return missing > 0 ? `(+${missing} earlier lines omitted)` : undefined;
  };

  if (hasError) {
    // The chat surface posts only the first part of this reply, so the detail
    // lines take whatever the header, the error text and the note leave. The
    // newest lines are the ones kept: a forward slice would spend the visible
    // space on the oldest diagnostics.
    const header = `Cloud Agent session ${sessionId} encountered errors:`;
    const budget = Math.max(
      0,
      CHAT_REPLY_MAX_LENGTH - header.length - (errorMessage?.length ?? 0) - OMITTED_NOTE_RESERVE
    );
    const shown = newestLines(log.entries(), budget);
    const details = [errorMessage, missingNote(shown.length), ...shown].filter(Boolean).join('\n');
    return {
      response: `${header}\n${details}`,
      sessionId,
      hasError: true,
      statusMessages: [...log.entries()],
    };
  }

  if (completionResult) {
    return {
      response: `Cloud Agent session ${sessionId} completed:\n\n${completionResult}`,
      sessionId,
      hasError: false,
      statusMessages: [...log.entries()],
    };
  }

  const recent = log.entries().slice(-5);
  const tail = [missingNote(recent.length), ...recent].filter(Boolean).join('\n');
  return {
    response: `Cloud Agent session ${sessionId} completed successfully.\n\nStatus:\n${tail}`,
    sessionId,
    hasError: false,
    statusMessages: [...log.entries()],
  };
}
