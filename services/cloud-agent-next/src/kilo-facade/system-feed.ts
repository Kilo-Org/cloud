import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import type { CloudStatusType } from '../shared/protocol.js';
import {
  SandboxStatusSnapshotSchema,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { logger } from '../logger.js';
import { projectPublicCloudAgentExtensionEvent } from './cloud-agent-extension-events.js';
import {
  projectPublicStructuredPaths,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';

/**
 * The Cloud Agent system feed for a hosted session (spec §10). It carries the
 * infrastructure lifecycle a local Kilo client cannot otherwise observe:
 * preparation steps, the Cloud lifecycle status, and the sandbox status
 * snapshot.
 *
 * The data is the session DO's authoritative `/stream` feed, bridged into a
 * bounded SSE response. The event channel replays the stored preparation and
 * cloud-status events with the materialized preparation snapshots, then tails
 * live pushes; a second upstream carries the sandbox status snapshot and its
 * live updates. The bridge only reads — it never prepares a route or wakes the
 * sandbox — and every payload passes an allowlist before it reaches a client.
 */

/** Public Kilo facade path for the system feed (the `/kilo` prefix is stripped). */
export const SYSTEM_FEED_KILO_PATH = '/cloud-agent/event';

/** The stored event types the event channel replays and tails. */
const SYSTEM_FEED_EVENT_TYPES = 'preparing,cloud.status';

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_SYSTEM_FEED_QUEUE_SIZE = 64;
const MAX_SYSTEM_FEED_EVENT_BYTES = 256 * 1024;
const SLOW_SUBSCRIBER_ERROR = 'System event subscriber fell behind';

const encoder = new TextEncoder();

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One event the system feed publishes, addressed by the public session id. */
export type PublicSystemFeedEvent =
  | {
      type: 'preparing';
      properties: { sessionID: string; directory: string; preparation: JsonRecord };
    }
  | {
      type: 'cloud.status';
      properties: {
        sessionID: string;
        directory: string;
        cloudStatus: { type: CloudStatusType; step?: string; message?: string };
      };
    }
  | {
      type: 'cloud.sandbox.status';
      properties: { sessionID: string; directory: string; sandbox: SandboxStatusSnapshot };
    };

/**
 * Projects one stored stream event into the public system feed, or null when it
 * is not part of the allowlist. Preparation payloads are path-projected; the
 * sandbox snapshot is schema-validated; the Cloud status reuses the existing
 * public extension-event projection.
 */
export function projectSystemFeedEvent(
  streamEventType: string,
  data: unknown,
  kiloSessionId: string
): PublicSystemFeedEvent | null {
  const directory = publicCloudAgentDirectory(kiloSessionId);
  switch (streamEventType) {
    case 'preparing': {
      if (!isRecord(data)) return null;
      const preparation = projectPublicStructuredPaths({ ...data }, kiloSessionId);
      if (typeof preparation.step !== 'string') return null;
      return {
        type: 'preparing',
        properties: { sessionID: kiloSessionId, directory, preparation },
      };
    }
    case 'cloud.status':
    case 'connected': {
      // Both carry `cloudStatus`: a `cloud.status` event and the derived status
      // in the connect snapshot.
      const cloudStatus = isRecord(data) ? data.cloudStatus : undefined;
      const projected = projectPublicCloudAgentExtensionEvent(
        { stream_event_type: 'cloud.status', payload: JSON.stringify({ cloudStatus }) },
        kiloSessionId
      );
      if (projected === null || projected.type !== 'cloud.status') return null;
      return {
        type: 'cloud.status',
        properties: {
          sessionID: kiloSessionId,
          directory,
          cloudStatus: projected.properties.cloudStatus,
        },
      };
    }
    case 'cloud.sandbox.status': {
      const parsed = SandboxStatusSnapshotSchema.safeParse(data);
      if (!parsed.success) return null;
      return {
        type: 'cloud.sandbox.status',
        properties: { sessionID: kiloSessionId, directory, sandbox: parsed.data },
      };
    }
    default:
      return null;
  }
}

export type SystemFeedChannel = 'events' | 'sandbox';

/** One parsed upstream stream event, tagged with the channel it arrived on. */
export type SystemFeedUpstreamFrame = { channel: SystemFeedChannel; payload: unknown };

export type SystemFeedUpstream = { close(): void };

export type SystemFeedUpstreamFactory = (params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  onFrame: (frame: SystemFeedUpstreamFrame) => void;
  onEnd: (channel: SystemFeedChannel) => void;
}) => Promise<SystemFeedUpstream>;

function parseFrame(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Opens one upstream `/stream` WebSocket on the session DO. A DO may use a
 * WebSocket as a client to another DO; the returned socket is the client end.
 */
async function openSessionStreamSocket(params: {
  stub: DurableObjectStub<SandboxSessionV2>;
  search: string;
  operationName: string;
  onMessage: (payload: unknown) => void;
  onEnd: () => void;
}): Promise<SystemFeedUpstream | null> {
  let response: Response;
  try {
    response = await withDORetry(
      () => params.stub,
      current =>
        current.fetch(
          new Request(`https://session.internal/stream${params.search}`, {
            headers: { Upgrade: 'websocket' },
          })
        ),
      params.operationName
    );
  } catch {
    logger.withFields({ operation: params.operationName }).warn('System feed upstream open failed');
    return null;
  }
  const socket = response.webSocket;
  if (!socket) return null;
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const payload = parseFrame(event.data);
    if (payload !== null) params.onMessage(payload);
  });
  socket.addEventListener('close', () => params.onEnd());
  socket.addEventListener('error', () => params.onEnd());
  socket.accept();
  return {
    close() {
      try {
        socket.close(1000, 'System feed closed');
      } catch {
        // The socket is already closed.
      }
    },
  };
}

/**
 * Opens the two authoritative upstreams: the filtered event channel and the
 * sandbox status channel. Both are reads that never wake compute.
 */
export const defaultSystemFeedUpstream: SystemFeedUpstreamFactory = async params => {
  const stub = getSandboxSessionStub(params.env, params.userId, params.cloudAgentSessionId);
  const opened: SystemFeedUpstream[] = [];
  const [events, sandbox] = await Promise.all([
    openSessionStreamSocket({
      stub,
      search: `?eventTypes=${SYSTEM_FEED_EVENT_TYPES}`,
      operationName: 'systemFeedEvents',
      onMessage: payload => params.onFrame({ channel: 'events', payload }),
      onEnd: () => params.onEnd('events'),
    }),
    openSessionStreamSocket({
      stub,
      search: '?sandboxStatus=true',
      operationName: 'systemFeedSandboxStatus',
      onMessage: payload => params.onFrame({ channel: 'sandbox', payload }),
      onEnd: () => params.onEnd('sandbox'),
    }),
  ]);
  if (events !== null) opened.push(events);
  if (sandbox !== null) opened.push(sandbox);
  if (events === null || sandbox === null) {
    for (const upstream of opened) upstream.close();
    throw new Error('System event source unavailable');
  }
  return {
    close() {
      for (const upstream of opened) upstream.close();
    },
  };
};

/**
 * Opens the bounded SSE system feed for one owned hosted session. Backpressure
 * ends the subscriber and closes both upstreams; cancel does the same. The
 * channel ending closes the stream so a client reconnects to fresh snapshots.
 */
export function openSystemFeedStream(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  /** Test seam; production uses `defaultSystemFeedUpstream`. */
  openUpstream?: SystemFeedUpstreamFactory;
}): Response {
  const openUpstream = params.openUpstream ?? defaultSystemFeedUpstream;
  let upstream: SystemFeedUpstream | 'opening' | 'closed' = 'opening';
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const closeUpstream = (): void => {
    const current = upstream;
    upstream = 'closed';
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (typeof current !== 'string') current.close();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const stop = (error?: Error): void => {
          closeUpstream();
          if (error === undefined) {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
            return;
          }
          try {
            controller.error(error);
          } catch {
            // Already closed.
          }
        };
        const enqueue = (frame: Uint8Array): void => {
          if (upstream === 'closed') return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            stop(new Error(SLOW_SUBSCRIBER_ERROR));
            return;
          }
          try {
            controller.enqueue(frame);
          } catch {
            stop(new Error(SLOW_SUBSCRIBER_ERROR));
          }
        };
        heartbeat = setInterval(
          () => enqueue(encoder.encode(': heartbeat\n\n')),
          HEARTBEAT_INTERVAL_MS
        );
        const onFrame = (frame: SystemFeedUpstreamFrame): void => {
          if (!isRecord(frame.payload)) return;
          const streamEventType = frame.payload.streamEventType;
          if (typeof streamEventType !== 'string') return;
          const event = projectSystemFeedEvent(
            streamEventType,
            frame.payload.data,
            params.kiloSessionId
          );
          if (event === null) return;
          const encoded = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
          if (encoded.byteLength > MAX_SYSTEM_FEED_EVENT_BYTES) return;
          enqueue(encoded);
        };
        try {
          const opened = await openUpstream({
            env: params.env,
            userId: params.userId,
            cloudAgentSessionId: params.cloudAgentSessionId,
            onFrame,
            onEnd: () => stop(),
          });
          if (upstream === 'closed') opened.close();
          else upstream = opened;
        } catch {
          logger.warn('System feed upstream failed');
          stop(new Error('System event source unavailable'));
        }
      },
      cancel() {
        closeUpstream();
      },
    },
    { highWaterMark: MAX_SYSTEM_FEED_QUEUE_SIZE, size: () => 1 }
  );

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
