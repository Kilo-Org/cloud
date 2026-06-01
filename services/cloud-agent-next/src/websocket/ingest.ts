/**
 * Ingest handler for the /ingest WebSocket endpoint.
 *
 * This module provides the internal WebSocket handler that:
 * - Accepts WebSocket connections from the wrapper process inside the sandbox
 * - Persists incoming events to SQLite storage
 * - Broadcasts events to connected /stream clients
 * - Handles kiloSessionId capture from session_created events
 * - Handles branch capture from complete events
 * - Handles execution lifecycle (complete/interrupted/error)
 *
 * The /ingest endpoint is internal-only - it should only be called
 * by the wrapper via DO fetch, not exposed to external clients.
 */

import type { IngestEvent, StoredEvent } from './types.js';
import type { EventId, SessionId } from '../types/ids.js';
import type { EventQueries } from '../session/queries/index.js';
import { createErrorMessage } from './stream.js';
import { z } from 'zod';
import {
  handleKilocodeEvent,
  handleBranchCapture,
  handleCommandsAvailable,
  extractEntityId,
} from '../session/ingest-handlers/index.js';
import type { CompleteEventData, KilocodeEventData, CloudStatusData } from '../shared/protocol.js';
import type { SlashCommandInfo } from '../shared/slash-commands.js';
import { logger } from '../logger.js';
import type { WrapperSupervisor } from '../session/wrapper-supervisor.js';

// ---------------------------------------------------------------------------
// Ingest Attachment
// ---------------------------------------------------------------------------

/** Debounce interval for heartbeat updates (30 seconds) */
const HEARTBEAT_DEBOUNCE_MS = 30_000;

const completeEventSchema = z.object({
  exitCode: z.number(),
  currentBranch: z.string().optional(),
  gateResult: z.enum(['pass', 'fail']).optional(),
});

const kilocodeEventSchema = z
  .object({
    event: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();

const interruptedEventSchema = z.object({
  reason: z.string().optional(),
  exitCode: z.number().optional(),
});

const errorEventSchema = z.object({
  fatal: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

const wrapperGenerationParamSchema = z.coerce.number().int().nonnegative();

function getAssistantErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    if ('data' in error && error.data && typeof error.data === 'object') {
      if ('message' in error.data && typeof error.data.message === 'string') {
        return error.data.message;
      }
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }
  return 'Assistant message failed';
}

// ---------------------------------------------------------------------------
// Persistence Allowlists
// ---------------------------------------------------------------------------

/**
 * Kilocode events with entity IDs are always persisted via upsert:
 *   - message.updated   → entity_id: message/{id}
 *   - message.part.updated → entity_id: part/{messageID}/{partId}
 * See extractEntityId() for the mapping.
 *
 * The sets below cover events persisted via **plain insert**.
 * Any event not covered by entity-ID upsert or these sets is broadcast-only:
 * delivered to /stream clients in real time but not written to SQLite.
 */

/** Non-kilocode stream event types persisted to SQLite via plain insert. */
const PERSISTED_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  'complete',
  'interrupted',
  'error',
  'autocommit_started',
  'autocommit_completed',
]);

/** Kilocode event names persisted to SQLite via plain insert (no entity-ID dedup). */
const PERSISTED_KILO_EVENT_NAMES: ReadonlySet<string> = new Set([
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.status',
  'session.error',
  'session.idle',
  'session.turn.close',
]);

const ingestAttachmentSchema = z.object({
  wrapperRunId: z.string(),
  sessionId: z.string().optional(),
  connectedAt: z.number(),
  kiloSessionState: z.object({ captured: z.boolean() }),
  lastHeartbeatUpdate: z.number(),
  lastEventAtUpdate: z.number(),
  wrapperGeneration: z.number().int().nonnegative(),
  wrapperConnectionId: z.string(),
});

export type IngestAttachment = z.infer<typeof ingestAttachmentSchema>;

// ---------------------------------------------------------------------------
// DO Context for handlers
// ---------------------------------------------------------------------------

export type IngestDOContext = {
  updateKiloSessionId: (id: string) => Promise<void>;
  updateUpstreamBranch: (branch: string) => Promise<void>;
  wrapperSupervisor: Pick<
    WrapperSupervisor,
    | 'checkReconnect'
    | 'recordReconnectAccepted'
    | 'isCurrentConnection'
    | 'observePong'
    | 'observeMeaningfulOutput'
    | 'observeRootIdle'
    | 'onTerminalEvent'
  >;
  keepContainerAlive?: () => void;
  observeCorrelatedAgentActivity?: (messageId: string) => Promise<void>;
  terminalizeSessionMessageOnce?: (
    messageId: string,
    params: {
      kind: 'completed' | 'failed' | 'interrupted';
      assistantMessageId?: string;
      completionSource: string;
      reason?: string;
      error?: string;
    },
    wrapperRunId: string
  ) => Promise<void>;
  /** Persist the slash-command catalog so connecting clients can be hydrated. */
  setAvailableCommands: (commands: SlashCommandInfo[]) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Ingest Handler Factory
// ---------------------------------------------------------------------------

/**
 * Create an ingest handler for the /ingest WebSocket endpoint.
 *
 * The handler uses Cloudflare's WebSocket hibernation API:
 * - `state.acceptWebSocket()` registers the WebSocket with hibernation support
 * - `serializeAttachment()` persists wrapper-run attribution across hibernation
 * - Uses `ingest:{wrapperRunId}` tags for identification
 *
 * @param state - Durable Object state for WebSocket management
 * @param eventQueries - Event queries module for persisting events
 * @param sessionId - Session ID for this DO instance
 * @param broadcastFn - Function to broadcast events to /stream clients
 * @param doContext - Context for calling back into DO for session capture, branch, and lifecycle
 * @returns Ingest handler object with methods for WebSocket operations
 */
export function createIngestHandler(
  state: DurableObjectState,
  eventQueries: EventQueries,
  sessionId: SessionId,
  broadcastFn: (event: StoredEvent) => void,
  doContext: IngestDOContext
) {
  async function forwardIngestTerminalEvent(params: {
    wrapperRunId: string;
    status: 'completed' | 'failed' | 'interrupted';
    error?: string;
    gateResult?: 'pass' | 'fail';
  }): Promise<void> {
    await doContext.wrapperSupervisor.onTerminalEvent(params);
  }

  function readCurrentAttachment(ws: WebSocket): IngestAttachment | null {
    const parsed = ingestAttachmentSchema.safeParse(ws.deserializeAttachment());
    if (parsed.success) return parsed.data;

    logger.withFields({ sessionId }).warn('Ignoring obsolete or invalid wrapper attachment');
    try {
      ws.close(4401, 'Obsolete wrapper connection');
    } catch {
      // Ignore close errors while quarantining obsolete hibernated sockets.
    }
    return null;
  }

  return {
    /**
     * Handle incoming /ingest WebSocket upgrade request.
     *
     * Wrapper connections must provide the fully fenced wrapper-run identity.
     *
     * @param request - The incoming HTTP request with WebSocket upgrade
     * @returns HTTP response (101 on success, error status otherwise)
     */
    async handleIngestRequest(request: Request): Promise<Response> {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const url = new URL(request.url);
      const wrapperRunId = url.searchParams.get('wrapperRunId');
      if (!wrapperRunId) {
        logger.withFields({ sessionId }).warn('Wrapper ingest rejected: missing wrapperRunId');
        return new Response('Missing wrapperRunId parameter', { status: 400 });
      }

      const wrapperGenerationParam = url.searchParams.get('wrapperGeneration');
      const wrapperConnectionId = url.searchParams.get('wrapperConnectionId') ?? undefined;
      const parsedWrapperGeneration = wrapperGenerationParam
        ? wrapperGenerationParamSchema.safeParse(wrapperGenerationParam)
        : undefined;

      if (wrapperGenerationParam && !parsedWrapperGeneration?.success) {
        logger
          .withFields({ sessionId, wrapperRunId })
          .warn('Wrapper ingest rejected: invalid wrapperGeneration');
        return new Response('Invalid wrapperGeneration parameter', { status: 400 });
      }

      if (parsedWrapperGeneration?.success && !wrapperConnectionId) {
        logger
          .withFields({ sessionId, wrapperRunId, wrapperGeneration: parsedWrapperGeneration.data })
          .warn('Wrapper ingest rejected: missing wrapperConnectionId');
        return new Response('Missing wrapperConnectionId parameter', { status: 400 });
      }

      if (wrapperConnectionId && !parsedWrapperGeneration?.success) {
        logger
          .withFields({ sessionId, wrapperRunId, wrapperConnectionId })
          .warn('Wrapper ingest rejected: missing wrapperGeneration');
        return new Response('Missing wrapperGeneration parameter', { status: 400 });
      }

      const wrapperGeneration = parsedWrapperGeneration?.success
        ? parsedWrapperGeneration.data
        : undefined;

      return this.handleNewPathIngestRequest({
        wrapperRunId,
        wrapperGeneration,
        wrapperConnectionId,
        request,
      });
    },

    async handleNewPathIngestRequest(params: {
      wrapperRunId: string;
      wrapperGeneration?: number;
      wrapperConnectionId?: string;
      request: Request;
    }): Promise<Response> {
      const { wrapperRunId, wrapperGeneration, wrapperConnectionId } = params;

      const url = new URL(params.request.url);
      const sessionIdParam = url.searchParams.get('sessionId');
      if (!sessionIdParam) {
        logger
          .withFields({ sessionId, wrapperRunId, wrapperGeneration, wrapperConnectionId })
          .warn('Wrapper ingest rejected: missing sessionId');
        return new Response('Missing sessionId parameter', { status: 400 });
      }

      if (wrapperGeneration === undefined || !wrapperConnectionId) {
        logger
          .withFields({ sessionId, wrapperRunId, wrapperGeneration, wrapperConnectionId })
          .warn('Wrapper ingest rejected: missing connection fence');
        return new Response(
          'wrapperGeneration and wrapperConnectionId are required with wrapperRunId',
          { status: 400 }
        );
      }

      const reconnectDecision = await doContext.wrapperSupervisor.checkReconnect({
        wrapperRunId,
        wrapperGeneration,
        wrapperConnectionId,
      });
      if (!reconnectDecision.accepted) {
        const isStaleRun = reconnectDecision.reason === 'stale-wrapper-run';
        logger
          .withFields({
            sessionId,
            wrapperRunId,
            wrapperGeneration,
            wrapperConnectionId,
          })
          .warn(
            isStaleRun
              ? 'Wrapper ingest rejected: stale wrapper run'
              : 'Wrapper ingest rejected: stale wrapper connection'
          );
        return new Response(isStaleRun ? 'Stale wrapper run' : 'Stale wrapper connection', {
          status: 409,
        });
      }

      if (sessionIdParam !== sessionId) {
        logger
          .withFields({
            sessionId,
            providedSessionId: sessionIdParam,
            wrapperRunId,
            wrapperGeneration,
            wrapperConnectionId,
          })
          .warn('Wrapper ingest rejected: sessionId mismatch');
        return new Response('Invalid sessionId parameter', { status: 401 });
      }

      const ingestTag = `ingest:${wrapperRunId}`;
      let replacedSocketCount = 0;
      for (const existingWs of state.getWebSockets(ingestTag)) {
        const existingAttachment = ingestAttachmentSchema.safeParse(
          existingWs.deserializeAttachment()
        );
        const shouldReplace =
          existingAttachment.success &&
          existingAttachment.data.wrapperGeneration === wrapperGeneration &&
          existingAttachment.data.wrapperConnectionId === wrapperConnectionId;
        if (!shouldReplace) continue;
        try {
          existingWs.close(1000, 'Replaced by new connection');
          replacedSocketCount++;
        } catch {
          // Ignore close errors on already-closed connections
        }
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const now = Date.now();

      const attachment: IngestAttachment = {
        wrapperRunId,
        sessionId: sessionIdParam,
        connectedAt: now,
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: now,
        lastEventAtUpdate: 0,
        wrapperGeneration,
        wrapperConnectionId,
      };

      state.acceptWebSocket(server, [ingestTag]);
      server.serializeAttachment(attachment);

      await doContext.wrapperSupervisor.recordReconnectAccepted({
        wrapperGeneration,
        wrapperConnectionId,
      });

      doContext.keepContainerAlive?.();
      logger
        .withFields({
          sessionId,
          wrapperRunId,
          wrapperGeneration,
          wrapperConnectionId,
          replacedSocketCount,
          activeIngestSocketCount: state.getWebSockets(ingestTag).length,
        })
        .info('Wrapper ingest WebSocket accepted');

      return new Response(null, { status: 101, webSocket: client });
    },

    /**
     * Handle incoming message on an ingest WebSocket.
     *
     * Persists events into SQLite with wrapperRunId-bound identity and
     * broadcasts them to /stream clients.
     *
     * @param ws - The WebSocket that received the message
     * @param message - The incoming message (should be JSON string)
     */
    async handleIngestMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      if (typeof message !== 'string') {
        ws.send(
          JSON.stringify(createErrorMessage('WS_PROTOCOL_ERROR', 'Binary messages not supported'))
        );
        return;
      }

      const attachment = readCurrentAttachment(ws);
      if (!attachment) return;

      const { wrapperRunId, wrapperGeneration, wrapperConnectionId } = attachment;
      const eventSourceId = '';

      const isCurrent = await doContext.wrapperSupervisor.isCurrentConnection(
        wrapperGeneration,
        wrapperConnectionId
      );
      if (!isCurrent) {
        console.warn('Closing stale wrapper socket on ingest message', {
          wrapperRunId,
          wrapperGeneration,
          wrapperConnectionId,
        });
        try {
          ws.close(4401, 'Stale wrapper connection');
        } catch {
          // ignore - socket may already be closing
        }
        return;
      }

      try {
        const ingestEvent = JSON.parse(message) as IngestEvent;

        if (!ingestEvent.streamEventType) {
          ws.send(
            JSON.stringify(createErrorMessage('WS_PROTOCOL_ERROR', 'Missing streamEventType field'))
          );
          return;
        }

        const timestamp = ingestEvent.timestamp
          ? new Date(ingestEvent.timestamp).getTime()
          : Date.now();

        const eventType = ingestEvent.streamEventType;
        const payload = JSON.stringify(ingestEvent.data ?? {});
        const eventTypeStr: string = eventType;

        const now = Date.now();
        const kiloEventName =
          eventType === 'kilocode'
            ? ((ingestEvent.data as Record<string, unknown> | undefined)?.event as
                | string
                | undefined)
            : undefined;
        const isSessionIdle = kiloEventName === 'session.idle';

        if (wrapperGeneration !== undefined && wrapperConnectionId) {
          if (eventType === 'pong') {
            await doContext.wrapperSupervisor.observePong(
              wrapperGeneration,
              wrapperConnectionId,
              now
            );
          } else if (
            eventTypeStr !== 'wrapper_resumed' &&
            eventTypeStr !== 'heartbeat' &&
            !isSessionIdle
          ) {
            await doContext.wrapperSupervisor.observeMeaningfulOutput(
              wrapperGeneration,
              wrapperConnectionId,
              now
            );
          }
        }

        let eventId: number;

        if (eventType === 'kilocode') {
          const kiloEventName = (ingestEvent.data as Record<string, unknown> | undefined)?.event as
            | string
            | undefined;
          const data = ingestEvent.data as Record<string, unknown>;
          const entityId = extractEntityId(kiloEventName ?? '', data);
          if (entityId) {
            eventId = eventQueries.upsert({
              executionId: eventSourceId,
              sessionId,
              streamEventType: eventType,
              payload,
              timestamp,
              entityId,
            });
          } else if (kiloEventName && PERSISTED_KILO_EVENT_NAMES.has(kiloEventName)) {
            eventId = eventQueries.insert({
              executionId: eventSourceId,
              sessionId,
              streamEventType: eventType,
              payload,
              timestamp,
            });
          } else {
            eventId = 0;
          }
        } else if (PERSISTED_STREAM_EVENT_TYPES.has(eventType)) {
          eventId = eventQueries.insert({
            executionId: eventSourceId,
            sessionId,
            streamEventType: eventType,
            payload,
            timestamp,
          });
        } else {
          eventId = 0;
        }

        const storedEvent: StoredEvent = {
          id: eventId,
          execution_id: eventSourceId,
          session_id: sessionId,
          stream_event_type: eventType,
          payload,
          timestamp,
        };

        broadcastFn(storedEvent);

        if (eventType === 'preparing') {
          const preparingData = ingestEvent.data as { step?: string; message?: string } | undefined;
          broadcastFn({
            id: 0 as EventId,
            execution_id: eventSourceId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: {
                type: 'preparing',
                step: preparingData?.step,
                message: preparingData?.message,
              },
            } satisfies CloudStatusData),
            timestamp,
          });
        }

        if (now - attachment.lastHeartbeatUpdate >= HEARTBEAT_DEBOUNCE_MS) {
          attachment.lastHeartbeatUpdate = now;
          ws.serializeAttachment(attachment);
          doContext.keepContainerAlive?.();
        }
        if (eventType !== 'heartbeat') {
          if (now - attachment.lastEventAtUpdate >= HEARTBEAT_DEBOUNCE_MS) {
            attachment.lastEventAtUpdate = now;
            ws.serializeAttachment(attachment);
          }
        }

        // -- Handler integrations --

        // Handle commands.available (cache catalog in DO metadata)
        if (eventType === 'commands.available') {
          await handleCommandsAvailable(ingestEvent.data, {
            setAvailableCommands: cmds => doContext.setAvailableCommands(cmds),
            logger: console,
          });
        }

        // Handle kilocode events (session ID capture)
        if (eventType === 'kilocode') {
          const parsedKilocode = kilocodeEventSchema.safeParse(ingestEvent.data);
          if (parsedKilocode.success) {
            await handleKilocodeEvent(
              parsedKilocode.data as KilocodeEventData,
              attachment.kiloSessionState,
              {
                updateKiloSessionId: id => doContext.updateKiloSessionId(id),
                logger: console,
              }
            );
            ws.serializeAttachment(attachment);
          } else {
            console.warn('Invalid kilocode event payload', parsedKilocode.error);
          }
        }

        if (isSessionIdle && wrapperGeneration !== undefined && wrapperConnectionId) {
          await doContext.wrapperSupervisor.observeRootIdle(
            wrapperGeneration,
            wrapperConnectionId,
            now
          );
        }

        // Terminalize user messages from terminal assistant message.updated events only.
        // Partial updates (no time.completed or error) must not terminalize.
        if (eventType === 'kilocode') {
          const data = ingestEvent.data as Record<string, unknown>;
          const eventName = data.event;
          if (eventName === 'message.updated') {
            const properties = data.properties as Record<string, unknown> | undefined;
            const info = properties?.info as Record<string, unknown> | undefined;
            const time = info?.time as Record<string, unknown> | undefined;
            const isCompleted = Boolean(time?.completed);
            const assistantError = getAssistantErrorMessage(info?.error);
            const hasError = assistantError !== undefined;
            const isTerminal = isCompleted || hasError;
            const parentMessageId =
              info?.role === 'assistant' && typeof info.parentID === 'string'
                ? info.parentID
                : undefined;
            if (parentMessageId !== undefined) {
              await doContext.observeCorrelatedAgentActivity?.(parentMessageId);
              if (isTerminal) {
                await doContext.terminalizeSessionMessageOnce?.(
                  parentMessageId,
                  {
                    kind: hasError ? 'failed' : 'completed',
                    assistantMessageId: typeof info?.id === 'string' ? info.id : undefined,
                    completionSource: 'assistant_message_event',
                    reason: hasError ? 'assistant_error' : undefined,
                    error: assistantError,
                  },
                  wrapperRunId
                );
              }
            }
          }
        }

        if (eventTypeStr === 'autocommit_started') {
          broadcastFn({
            id: 0 as EventId,
            execution_id: eventSourceId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: {
                type: 'finalizing',
                step: 'committing',
                message: 'Committing changes...',
              },
            } satisfies CloudStatusData),
            timestamp,
          });
        }
        if (eventTypeStr === 'autocommit_completed') {
          broadcastFn({
            id: 0 as EventId,
            execution_id: eventSourceId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: { type: 'ready' },
            } satisfies CloudStatusData),
            timestamp,
          });
        }

        if (eventType === 'complete') {
          broadcastFn({
            id: 0 as EventId,
            execution_id: eventSourceId,
            session_id: sessionId,
            stream_event_type: 'cloud.status',
            payload: JSON.stringify({
              cloudStatus: { type: 'ready' },
            } satisfies CloudStatusData),
            timestamp,
          });

          const parsedComplete = completeEventSchema.safeParse(ingestEvent.data);
          if (!parsedComplete.success) {
            console.warn('Invalid complete event payload', parsedComplete.error);
            return;
          }
          await handleBranchCapture(parsedComplete.data as CompleteEventData, {
            updateUpstreamBranch: branch => doContext.updateUpstreamBranch(branch),
            logger: console,
          });
          await forwardIngestTerminalEvent({
            wrapperRunId,
            status: 'completed',
            gateResult: parsedComplete.data.gateResult,
          });
          logger
            .withFields({
              sessionId,
              wrapperRunId,
              wrapperGeneration,
              wrapperConnectionId,
              gateResult: parsedComplete.data.gateResult,
            })
            .info('Wrapper complete event forwarded to session coordinator');
        }

        if (eventType === 'interrupted') {
          const parsedInterrupted = interruptedEventSchema.safeParse(ingestEvent.data);
          if (!parsedInterrupted.success) {
            console.warn('Invalid interrupted event payload', parsedInterrupted.error);
            return;
          }
          const interruptedError = parsedInterrupted.data.reason ?? 'User interrupted';
          await forwardIngestTerminalEvent({
            wrapperRunId,
            status: 'interrupted',
            error: interruptedError,
          });
          logger
            .withFields({
              sessionId,
              wrapperRunId,
              wrapperGeneration,
              wrapperConnectionId,
            })
            .info('Wrapper interrupted event forwarded to session coordinator');
        }

        if (eventType === 'error') {
          const parsedError = errorEventSchema.safeParse(ingestEvent.data);
          if (!parsedError.success) {
            console.warn('Invalid error event payload', parsedError.error);
            return;
          }
          const errorData = parsedError.data;
          if (errorData.fatal) {
            const fatalMessage = errorData.error ?? errorData.message ?? 'Fatal error';
            broadcastFn({
              id: 0 as EventId,
              execution_id: eventSourceId,
              session_id: sessionId,
              stream_event_type: 'cloud.status',
              payload: JSON.stringify({
                cloudStatus: { type: 'error', message: fatalMessage },
              } satisfies CloudStatusData),
              timestamp,
            });
            await forwardIngestTerminalEvent({
              wrapperRunId,
              status: 'failed',
              error: fatalMessage,
            });
            logger
              .withFields({
                sessionId,
                wrapperRunId,
                wrapperGeneration,
                wrapperConnectionId,
              })
              .warn('Fatal wrapper error event forwarded to session coordinator');
          }
        }
      } catch (error) {
        logger
          .withFields({
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          .error('Error processing wrapper ingest message');
        ws.send(
          JSON.stringify(
            createErrorMessage(
              'WS_INTERNAL_ERROR',
              error instanceof Error ? error.message : 'Failed to process event'
            )
          )
        );
      }
    },

    /**
     * Handle ingest WebSocket close.
     *
     * Returns the wrapper-run attribution only when no tagged ingest sockets
     * remain - i.e. the wrapper is truly disconnected, not just replaced by
     * a reconnection.
     *
     * Uses state.getWebSockets() which is authoritative across hibernation
     * and excludes already-disconnected sockets.
     *
     * @param ws - The WebSocket that closed
     */
    async handleIngestClose(ws: WebSocket): Promise<{
      wrapperRunId: string;
      wrapperGeneration: number;
      wrapperConnectionId: string;
    } | null> {
      const attachment = readCurrentAttachment(ws);
      if (!attachment) return null;

      const { wrapperRunId, wrapperGeneration, wrapperConnectionId } = attachment;
      const isCurrent = await doContext.wrapperSupervisor.isCurrentConnection(
        wrapperGeneration,
        wrapperConnectionId
      );
      if (!isCurrent) {
        console.warn('Ignoring close of stale wrapper socket', {
          wrapperRunId,
          wrapperGeneration,
          wrapperConnectionId,
        });
        return null;
      }

      const ingestTag = `ingest:${wrapperRunId}`;
      const remaining = state.getWebSockets(ingestTag);
      if (remaining.length > 0) {
        logger
          .withFields({
            sessionId,
            wrapperRunId,
            wrapperGeneration,
            wrapperConnectionId,
            remainingIngestSockets: remaining.length,
          })
          .info('Wrapper ingest socket closed while replacement connection remains');
        return null;
      }

      logger
        .withFields({
          sessionId,
          wrapperRunId,
          wrapperGeneration,
          wrapperConnectionId,
        })
        .warn('Last wrapper ingest socket closed');
      return {
        wrapperRunId,
        wrapperGeneration,
        wrapperConnectionId,
      };
    },

    /**
     * Check if the current wrapper run has an active ingest connection.
     */
    hasActiveConnection(params: {
      wrapperRunId: string;
      wrapperGeneration: number;
      wrapperConnectionId: string;
    }): boolean {
      const ingestTag = `ingest:${params.wrapperRunId}`;
      const sockets = state.getWebSockets(ingestTag);
      return sockets.some(socket => {
        const attachment = ingestAttachmentSchema.safeParse(socket.deserializeAttachment());
        return (
          attachment.success &&
          attachment.data.wrapperGeneration === params.wrapperGeneration &&
          attachment.data.wrapperConnectionId === params.wrapperConnectionId
        );
      });
    },
  };
}

/** Type of the ingest handler object returned by createIngestHandler */
export type IngestHandler = ReturnType<typeof createIngestHandler>;
