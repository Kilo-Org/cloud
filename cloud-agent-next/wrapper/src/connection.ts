/**
 * Connection management for the long-running wrapper.
 *
 * Handles:
 * - Ingest WebSocket connection (for sending events to DO)
 * - SSE consumer (for receiving events from kilo server)
 *
 * Connections are opened on-demand when the wrapper transitions from IDLE to ACTIVE,
 * and closed when transitioning back to IDLE (after drain period).
 */

import type { WrapperState } from './state.js';
import type { IngestEvent, WrapperCommand } from '../../src/shared/protocol.js';
import { createSSEConsumer, isTerminalErrorEvent, type SSEConsumer } from './sse-consumer.js';
import { logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Kilo Event Types (from kilo-cli SDK)
// ---------------------------------------------------------------------------

/**
 * Time information for messages.
 */
type MessageTime = {
  created: number;
  completed?: number;
};

/**
 * Assistant message info from message.updated event.
 * Mirrors AssistantMessage from kilo-cli SDK.
 */
type AssistantMessageInfo = {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: MessageTime;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: unknown;
  summary?: boolean;
  finish?: string;
};

/**
 * User message info from message.updated event.
 */
type UserMessageInfo = {
  id: string;
  sessionID: string;
  role: 'user';
  time: MessageTime;
  agent: string;
  model: { providerID: string; modelID: string };
  summary?: { title?: string; body?: string };
  system?: string;
  tools?: Record<string, boolean>;
  variant?: string;
};

/**
 * Message info can be either user or assistant message.
 */
type MessageInfo = UserMessageInfo | AssistantMessageInfo;

/**
 * Type guard for message.updated kilocode event data.
 * Kilo server sends: {type: "message.updated", properties: {info: {...}}}
 * After mapping: {type: "message.updated", properties: {info: {...}}, event: "message.updated"}
 */
function isMessageUpdatedEvent(
  data: unknown
): data is { event: 'message.updated'; properties: { info: MessageInfo } } {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.event !== 'message.updated') return false;
  const props = obj.properties as Record<string, unknown> | undefined;
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof props.info === 'object' &&
    props.info !== null
  );
}

/**
 * Type guard for completed assistant message.
 */
function isCompletedAssistantMessage(
  info: MessageInfo
): info is AssistantMessageInfo & { time: { completed: number } } {
  return info.role === 'assistant' && typeof info.time.completed === 'number';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionConfig = {
  kiloServerPort: number;
};

export type ConnectionCallbacks = {
  /** Called when a completion event is detected for a message */
  onMessageComplete: (messageId: string) => void;
  /** Called when a terminal error is detected */
  onTerminalError: (reason: string) => void;
  /** Called when a command is received from DO */
  onCommand: (cmd: WrapperCommand) => void;
  /** Called when the connection unexpectedly closes */
  onDisconnect: (reason: string) => void;
  /** Called on any completion event to signal post-processing waiters */
  onCompletionSignal: () => void;
};

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> } | string | string[]
) => WebSocket;

// ---------------------------------------------------------------------------
// Connection Manager
// ---------------------------------------------------------------------------

export type ConnectionManager = {
  /** Open ingest WS and SSE consumer. Resolves when both are connected. */
  open: () => Promise<void>;
  /** Close both connections gracefully. */
  close: () => Promise<void>;
  /** Check if currently connected. */
  isConnected: () => boolean;
};

/**
 * Create a connection manager that handles ingest WS and SSE consumer.
 *
 * The connections are stored in WrapperState for reference, but actual
 * management (open/close) happens here.
 */
export function createConnectionManager(
  state: WrapperState,
  config: ConnectionConfig,
  callbacks: ConnectionCallbacks
): ConnectionManager {
  let sseConsumer: SSEConsumer | null = null;
  let ingestWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // Event buffer for disconnection periods
  const MAX_BUFFER_SIZE = 1000;
  const eventBuffer: IngestEvent[] = [];
  let bufferOverflowed = false;

  /**
   * Send an event to the ingest WebSocket.
   * Buffers events if disconnected.
   */
  function sendToIngest(event: IngestEvent): void {
    if (ingestWs && ingestWs.readyState === WebSocket.OPEN) {
      ingestWs.send(JSON.stringify(event));
    } else {
      // Buffer events while disconnected
      if (eventBuffer.length < MAX_BUFFER_SIZE) {
        eventBuffer.push(event);
      } else {
        bufferOverflowed = true;
      }
    }
  }

  /**
   * Flush buffered events after reconnection.
   */
  function flushBuffer(): void {
    if (!ingestWs || ingestWs.readyState !== WebSocket.OPEN) return;

    // Send resume marker so DO knows we may have lost events
    if (eventBuffer.length > 0 || bufferOverflowed) {
      ingestWs.send(
        JSON.stringify({
          streamEventType: 'wrapper_resumed',
          timestamp: new Date().toISOString(),
          data: { bufferedEvents: eventBuffer.length, eventsLost: bufferOverflowed },
        })
      );
    }

    // Flush buffer
    for (const event of eventBuffer) {
      ingestWs.send(JSON.stringify(event));
    }
    eventBuffer.length = 0;
    bufferOverflowed = false;
  }

  /**
   * Open the ingest WebSocket connection.
   */
  async function openIngestWs(): Promise<void> {
    const job = state.currentJob;
    if (!job) {
      throw new Error('Cannot open ingest WS: no job context');
    }

    const url = new URL(job.ingestUrl);
    url.searchParams.set('executionId', job.executionId);
    url.searchParams.set('sessionId', job.sessionId);
    url.searchParams.set('userId', job.userId);

    const wsUrl = url.toString();
    logToFile(`ingest WS connecting to: ${wsUrl}`);

    return new Promise<void>((resolve, reject) => {
      // Bun's WebSocket supports headers parameter
      const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtor;

      // Use kilocodeToken (user JWT) for auth - ingestToken is just executionId for DO validation
      const ws = new WebSocketWithHeaders(wsUrl, {
        headers: {
          Authorization: `Bearer ${job.kilocodeToken}`,
        },
      });

      ws.onopen = () => {
        logToFile(`ingest WS connected to: ${wsUrl}`);
        ingestWs = ws;
        flushBuffer();
        resolve();
      };

      ws.onclose = () => {
        logToFile(`ingest WS closed: ${wsUrl}`);
        if (ingestWs === ws) {
          ingestWs = null;
          callbacks.onDisconnect('ingest websocket closed');
        }
      };

      ws.onerror = () => {
        logToFile(`ingest WS error connecting to: ${wsUrl}`);
        if (!ingestWs) {
          reject(new Error(`Failed to connect to ingest: ${wsUrl}`));
        }
      };

      ws.onmessage = event => {
        try {
          const cmd = JSON.parse(String(event.data)) as WrapperCommand;
          callbacks.onCommand(cmd);
        } catch {
          // Ignore parse errors
        }
      };

      // Timeout for initial connection
      setTimeout(() => {
        if (!ingestWs) {
          ws.close();
          reject(new Error('Ingest connection timeout'));
        }
      }, 10_000);
    });
  }

  /**
   * Open the SSE consumer for kilo server events.
   */
  async function openSSEConsumer(): Promise<void> {
    const baseUrl = `http://127.0.0.1:${config.kiloServerPort}`;
    const abortController = new AbortController();

    sseConsumer = await createSSEConsumer({
      baseUrl,
      onActivity: () => {
        // Called for ALL SSE events including heartbeats - for activity tracking
        state.updateActivity();
        state.recordSseEvent();
      },
      onEvent: (event: IngestEvent) => {
        // Forward to ingest (heartbeats already filtered out)
        sendToIngest(event);

        // Check for terminal errors
        if (event.streamEventType === 'kilocode') {
          const data = event.data as Record<string, unknown>;
          const terminal = isTerminalErrorEvent({ event: String(data.event ?? ''), data });
          if (terminal.isTerminal) {
            callbacks.onTerminalError(terminal.reason ?? 'terminal error');
            return;
          }

          // Check for completion events using typed event guards
          if (isMessageUpdatedEvent(data)) {
            const { info } = data.properties;
            logToFile(
              `message.updated: role=${info.role} hasCompleted=${typeof info.time?.completed === 'number'} msgId=${info.id}`
            );
            if (isCompletedAssistantMessage(info)) {
              // Guard: only process completions for our current session
              const currentSessionId = state.currentJob?.kiloSessionId;
              if (currentSessionId && info.sessionID !== currentSessionId) {
                logToFile(
                  `ignoring completion for different session: event=${info.sessionID} current=${currentSessionId}`
                );
                return;
              }

              logToFile(`assistant message completed: ${info.id}`);
              // Signal completion for post-processing waiters
              callbacks.onCompletionSignal();
              // Note: We don't call onMessageComplete here because kilo's assistant message ID
              // differs from our tracked user message ID. session.idle handles inflight cleanup.
            }
          }

          // session.idle is the primary completion signal - it means the assistant finished
          // and the session is waiting for the next user input
          if (data.event === 'session.idle') {
            logToFile(`session.idle received - marking all inflight as complete`);
            // Complete ALL inflight messages for this job - the session is idle
            const inflightIds = state.inflightMessageIds;
            for (const messageId of inflightIds) {
              logToFile(`completing inflight messageId=${messageId}`);
              callbacks.onMessageComplete(messageId);
            }
            callbacks.onCompletionSignal();
          }
        }
      },
      onConnected: () => {
        logToFile('SSE consumer connected');
      },
      onClose: reason => {
        logToFile(`SSE consumer closed: ${reason}`);
        if (sseConsumer) {
          callbacks.onDisconnect(`SSE closed: ${reason}`);
        }
      },
      onError: error => {
        logToFile(`SSE consumer error: ${error.message}`);
      },
    });

    // Store abort controller in state (ingestWs is guaranteed set after openIngestWs resolves)
    if (!ingestWs) {
      throw new Error('ingestWs not set after openIngestWs');
    }
    state.setConnections(ingestWs, abortController);
    state.setSendToIngestFn(sendToIngest);
  }

  /**
   * Start heartbeat interval.
   */
  function startHeartbeat(): void {
    const job = state.currentJob;
    if (!job) return;

    heartbeatInterval = setInterval(() => {
      if (ingestWs?.readyState === WebSocket.OPEN) {
        ingestWs.send(
          JSON.stringify({
            streamEventType: 'heartbeat',
            data: { executionId: job.executionId },
            timestamp: new Date().toISOString(),
          })
        );
      }
    }, 20_000);
  }

  /**
   * Stop heartbeat interval.
   */
  function stopHeartbeat(): void {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  return {
    open: async () => {
      logToFile('opening connections');

      // Open both connections
      await openIngestWs();
      await openSSEConsumer();

      // Start heartbeat
      startHeartbeat();

      logToFile('connections opened');
    },

    close: async () => {
      logToFile('closing connections');

      // Stop heartbeat
      stopHeartbeat();

      // Stop SSE consumer
      if (sseConsumer) {
        sseConsumer.stop();
        sseConsumer = null;
      }

      // Close ingest WS
      if (ingestWs) {
        try {
          ingestWs.close();
        } catch {
          // Ignore close errors
        }
        ingestWs = null;
      }

      // Clear state references
      state.clearConnections();
      state.setSendToIngestFn(null);

      logToFile('connections closed');
    },

    isConnected: () => {
      return ingestWs !== null && ingestWs.readyState === WebSocket.OPEN && sseConsumer !== null;
    },
  };
}
