import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { getSessionIngestDO } from './SessionIngestDO';
import {
  CLIOutboundMessageSchema,
  parseCliRuntimePresence,
  type CLIInboundMessage,
  type SessionEventPayload,
  SessionEventPayloadSchema,
  type WebInboundMessage,
  WebOutboundMessageSchema,
} from '../types/user-connection-protocol';
import {
  createAndRunLocalSessionRequestSchema,
  createAndRunLocalSessionResultSchema,
  localRuntimeCatalogSchema,
  type CreateAndRunLocalSessionRequest,
  type CreateAndRunLocalSessionResult,
  type LocalRuntimeCatalog,
  type LocalRuntimeControlErrorCode,
  type LocalRuntimeFence,
  type LocalRuntimePresence,
} from '@kilocode/session-ingest-contracts';
type HeartbeatSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  parentSessionId?: string;
};

type RuntimeMetadata = LocalRuntimePresence & { lastHeartbeatAt: number };

type WSAttachment =
  | {
      role: 'cli';
      connectionId: string;
      sessions: HeartbeatSession[];
      // Undefined means no protocolVersion has been reported yet — either the
      // CLI hasn't sent its first heartbeat, or it's a legacy build that
      // predates this field entirely. Both cases fall back to legacy behavior.
      protocolVersion?: string;
      // Set from the authenticated /user/cli route; undefined on sockets
      // accepted before this field existed. Needed for the session-ready push.
      kiloUserId?: string;
      // Safe runtime metadata persisted across hibernation. Never includes
      // the absolute launch directory; only sanitized display labels.
      runtime?: RuntimeMetadata;
    }
  | { role: 'web'; connectionId: string; subscribedSessions: string[]; replaced?: true };

export const MAX_CATALOG_RESULT_BYTES = 512 * 1024;

/**
 * Bounded size for a `create_and_run` CLI result. The discriminated union is
 * tiny (sessionId + promptStarted + optional fixed message), so a few KiB is
 * more than enough. The cap is intentionally separate from the catalog cap
 * so one relay response class cannot exhaust the other.
 */
export const MAX_CREATE_AND_RUN_RESULT_BYTES = 16 * 1024;

/**
 * Internal, typed failure raised by `UserConnectionDO.getRuntimeCatalog` (and
 * surfaced through the internal HTTP route). The relay never re-emits a raw
 * CLI error string — every failure collapses to a stable, mobile-branched
 * code; the message is operator-facing only and never leaves the worker
 * unredacted.
 */
export class LocalRuntimeCommandError extends Error {
  constructor(
    public readonly code: LocalRuntimeControlErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LocalRuntimeCommandError';
  }
}

const GET_CATALOG_COMMAND = 'get_catalog';
const CREATE_AND_RUN_COMMAND = 'create_and_run';
const COMMAND_NOT_ALLOWED_VIEWER_ERROR = {
  source: 'relay' as const,
  code: 'COMMAND_NOT_ALLOWED' as const,
  message: 'Command not allowed',
};

const SESSION_OWNER_CHANGED_ERROR = {
  source: 'relay',
  code: 'SESSION_OWNER_CHANGED',
  message: 'Session owner changed',
};

const CATALOG_TOO_LARGE_ERROR = {
  source: 'relay',
  code: 'CATALOG_TOO_LARGE',
  message: 'Model catalog response is too large',
};

const CATALOG_REQUEST_PENDING_ERROR = {
  source: 'relay',
  code: 'CATALOG_REQUEST_PENDING',
  message: 'Model catalog request already pending',
};

const PENDING_COMMAND_LIMIT_ERROR = {
  source: 'relay',
  code: 'PENDING_COMMAND_LIMIT',
  message: 'Too many pending commands',
};

const COMMAND_EXPIRED_ERROR = {
  source: 'relay',
  code: 'COMMAND_EXPIRED',
  message: 'Command expired',
};

const CLI_COMMAND_ERROR = {
  source: 'cli',
  message: 'Command failed',
};

export class UserConnectionDO extends DurableObject<Env> {
  private static readonly HEARTBEAT_TIMEOUT_MS = 30_000;
  private static readonly PENDING_COMMAND_TTL_MS = 35_000;
  private static readonly MAX_PENDING_COMMANDS = 128;
  /**
   * Hard cap on first-class runtimes. Matches the bounded contract used by
   * the internal runtime-control HTTP route and the local-runtime schema
   * (`localRuntimeListResponseSchema`). One DO is one Kilo user, so 32 is
   * far above the realistic fan-in.
   */
  private static readonly MAX_RUNTIMES = 32;

  // Which CLI connection owns each session
  private sessionOwners = new Map<string, string>();
  // Which web sockets want events for a session
  private webSubscriptions = new Map<string, Set<WebSocket>>();
  // Sessions per CLI connection (from heartbeat)
  private connectionSessions = new Map<string, HeartbeatSession[]>();
  // Protocol version per CLI connection (from heartbeat); absent = legacy CLI
  private connectionProtocolVersion = new Map<string, string | undefined>();
  // Pending command responses: correlationId → destination. Viewer-originated
  // commands carry the originating `ws`; relay-originated RPCs (e.g.
  // getRuntimeCatalog) carry an internal `pending` Promise instead. Either
  // one is set, never both.
  private pendingCommands = new Map<
    string,
    {
      ws?: WebSocket;
      pending?: {
        resolve: (value: LocalRuntimeCatalog | CreateAndRunLocalSessionResult) => void;
        reject: (reason: LocalRuntimeCommandError) => void;
      };
      sessionId?: string;
      originalId?: string;
      command: string;
      expectedOwnerConnectionId?: string;
      targetConnectionId: string;
      expiresAt: number;
      targetCliWs: WebSocket;
    }
  >();
  // Last heartbeat timestamp per CLI connectionId (for staleness eviction)
  private lastHeartbeatAt = new Map<string, number>();
  // First-class runtime presence indexed by runtimeId. Lives independently of
  // session ownership — a zero-session heartbeat still creates an entry, and
  // CLI sockets without a runtime field never populate this map.
  private runtimes = new Map<string, RuntimeMetadata>();

  private stateReconstructed = false;

  private ensureState(): void {
    if (this.stateReconstructed) return;

    let cliCount = 0;
    let webCount = 0;
    let sessionCount = 0;
    let runtimeCount = 0;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (!attachment) continue;

      if (attachment.role === 'cli') {
        cliCount++;
        const { connectionId, sessions, protocolVersion, runtime } = attachment;
        this.connectionSessions.set(connectionId, sessions);
        this.connectionProtocolVersion.set(connectionId, protocolVersion);
        sessionCount += sessions.length;
        for (const session of sessions) {
          this.sessionOwners.set(session.id, connectionId);
        }
        this.lastHeartbeatAt.set(connectionId, Date.now());
        if (runtime) {
          this.runtimes.set(runtime.runtimeId, runtime);
          runtimeCount++;
        }
      } else {
        if (attachment.replaced) continue;
        webCount++;
        for (const sessionId of attachment.subscribedSessions) {
          let subs = this.webSubscriptions.get(sessionId);
          if (!subs) {
            subs = new Set();
            this.webSubscriptions.set(sessionId, subs);
          }
          subs.add(ws);
        }
      }
    }

    console.log('State reconstructed after hibernation', {
      cliSockets: cliCount,
      webSockets: webCount,
      sessions: sessionCount,
      runtimes: runtimeCount,
      subscriptions: this.webSubscriptions.size,
    });

    this.stateReconstructed = true;
  }

  fetch(request: Request): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    this.ensureState();

    const url = new URL(request.url);
    const role = url.pathname.endsWith('/cli') ? 'cli' : 'web';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connectionId = url.searchParams.get('connectionId') ?? crypto.randomUUID();

    if (role === 'cli') {
      // Close any stale socket from a previous connection with the same ID (CLI reconnect)
      const reconnect = this.closeStaleSocket(connectionId);

      const kiloUserId = url.searchParams.get('kiloUserId') ?? undefined;
      const attachment: WSAttachment = { role: 'cli', connectionId, sessions: [], kiloUserId };
      this.ctx.acceptWebSocket(server, ['cli']);
      server.serializeAttachment(attachment);
      const now = Date.now();
      this.lastHeartbeatAt.set(connectionId, now);
      this.scheduleNextAlarm(now);

      console.log('CLI socket connected', {
        connectionId,
        reconnect,
        totalCliSockets: this.ctx.getWebSockets('cli').length,
      });

      if (!reconnect) {
        this.broadcastToWeb({
          type: 'system',
          event: 'cli.connected',
          data: { connectionId },
        });
      }
    } else {
      this.replaceWebSocket(connectionId);

      const attachment: WSAttachment = { role: 'web', connectionId, subscribedSessions: [] };
      this.ctx.acceptWebSocket(server, ['web']);
      server.serializeAttachment(attachment);

      const sessions = this.aggregateSessions();
      const runtimes = this.getRuntimePresence();

      console.log('Web socket connected', {
        connectionId,
        totalWebSockets: this.ctx.getWebSockets('web').length,
        activeSessions: sessions.length,
        activeRuntimes: runtimes.length,
      });
      this.sendToWeb(server, {
        type: 'system',
        event: 'sessions.list',
        data: { sessions },
      });
      this.sendToWeb(server, {
        type: 'system',
        event: 'runtimes.list',
        data: { runtimes: this.getRuntimePresence() },
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.ensureState();

    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    if (!attachment) {
      console.warn('WebSocket message from socket with no attachment');
      return;
    }

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const binaryByteCount = typeof message === 'string' ? undefined : message.byteLength;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('Failed to parse WebSocket message as JSON', {
        role: attachment.role,
        connectionId: attachment.connectionId,
        byteCount: binaryByteCount ?? new TextEncoder().encode(raw).byteLength,
      });
      return;
    }

    if (attachment.role === 'cli') {
      this.handleCliMessage(ws, attachment, parsed, raw, binaryByteCount);
    } else if (!attachment.replaced) {
      this.handleWebMessage(ws, attachment, parsed);
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.ensureState();

    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    if (!attachment) return;

    if (attachment.role === 'cli') {
      this.handleCliDisconnect(ws, attachment);
    } else {
      this.handleWebDisconnect(ws);
    }
  }

  webSocketError(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    console.error('WebSocket error', {
      role: attachment?.role ?? 'unknown',
      connectionId: attachment?.connectionId ?? 'unknown',
    });
    this.webSocketClose(ws, 0, '', false);
  }

  async alarm(): Promise<void> {
    this.ensureState();

    const now = Date.now();
    this.expirePendingCommands(now);
    const staleConnectionIds: string[] = [];

    for (const [connectionId, lastSeen] of this.lastHeartbeatAt) {
      if (now - lastSeen >= UserConnectionDO.HEARTBEAT_TIMEOUT_MS) {
        staleConnectionIds.push(connectionId);
      }
    }

    for (const connectionId of staleConnectionIds) {
      // Find and close the stale CLI WebSocket
      for (const ws of this.ctx.getWebSockets('cli')) {
        const att = ws.deserializeAttachment() as WSAttachment | null;
        if (att?.role === 'cli' && att.connectionId === connectionId) {
          console.log('Closing stale CLI connection (heartbeat timeout)', { connectionId });
          ws.close(4408, 'heartbeat timeout');
          break;
        }
      }
      // handleCliDisconnect will clean up connectionSessions/sessionOwners/lastHeartbeatAt
      // and emit runtime.disconnected for the owned runtime (if any) via the
      // webSocketClose callback.
    }

    this.scheduleNextAlarm(now);
  }

  // ---------------------------------------------------------------------------
  // CLI message handling
  // ---------------------------------------------------------------------------

  private handleCliMessage(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'cli' },
    parsed: unknown,
    raw: string,
    binaryByteCount: number | undefined
  ): void {
    const result = CLIOutboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('CLI message parse failed', {
        role: 'cli',
        connectionId: attachment.connectionId,
        byteCount: binaryByteCount ?? new TextEncoder().encode(raw).byteLength,
        issues: result.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      });
      return;
    }
    const msg = result.data;

    switch (msg.type) {
      case 'heartbeat':
        this.handleHeartbeat(ws, attachment, msg.sessions, msg.protocolVersion, msg.runtime, msg.sequence);
        break;
      case 'event':
        this.handleCliEvent(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
        break;
      case 'response':
        this.handleCliResponse(ws, msg.id, msg.result, msg.error);
        break;
    }
  }

  private handleHeartbeat(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'cli' },
    sessions: HeartbeatSession[],
    protocolVersion: string | undefined,
    rawRuntime: unknown,
    sequence: number | undefined
  ): void {
    const { connectionId } = attachment;
    const now = Date.now();
    this.lastHeartbeatAt.set(connectionId, now);
    this.connectionProtocolVersion.set(connectionId, protocolVersion);
    this.scheduleNextAlarm(now);

    // Resolve the runtime presence (if any) BEFORE applying session updates
    // so a strict-failure or fence mismatch can fail closed without touching
    // session state. The parsed value, when present, is the new authoritative
    // metadata for this CLI socket.
    let nextRuntime: RuntimeMetadata | undefined;
    if (rawRuntime !== undefined) {
      let parsedRuntime;
      try {
        parsedRuntime = parseCliRuntimePresence(rawRuntime);
      } catch (error) {
        console.warn('Runtime presence rejected by strict parse', {
          connectionId,
          issues: error instanceof Error ? error.message : 'unknown',
        });
        return;
      }
      if (parsedRuntime.connectionId !== connectionId) {
        console.warn('Runtime presence rejected: connectionId mismatch', {
          connectionId,
        });
        return;
      }
      // Mutation rejection: a live socket may not change its runtimeId.
      // If the attachment already records a runtime for this socket and the
      // new heartbeat carries a different runtimeId, fail closed.
      if (attachment.runtime && attachment.runtime.runtimeId !== parsedRuntime.runtimeId) {
        console.warn('Runtime presence rejected: runtimeId mutation on live socket', {
          connectionId,
          previousRuntimeId: attachment.runtime.runtimeId,
          nextRuntimeId: parsedRuntime.runtimeId,
        });
        return;
      }
      // Cross-socket collision: a different socket already owns this runtimeId.
      const existing = this.runtimes.get(parsedRuntime.runtimeId);
      if (existing && existing.connectionId !== connectionId) {
        console.warn('Runtime presence rejected: runtimeId already owned by another socket', {
          connectionId,
          runtimeId: parsedRuntime.runtimeId,
          ownerConnectionId: existing.connectionId,
        });
        return;
      }
      nextRuntime = { ...parsedRuntime, lastHeartbeatAt: now };
    }

    // Remove sessions this connection previously owned but no longer reports
    const previousSessions = this.connectionSessions.get(connectionId) ?? [];
    const currentIds = new Set(sessions.map(s => s.id));
    for (const prev of previousSessions) {
      if (!currentIds.has(prev.id) && this.sessionOwners.get(prev.id) === connectionId) {
        this.sessionOwners.delete(prev.id);
        this.failPendingCommandsForOwnerChange(prev.id, undefined);
      }
    }

    // Update ownership
    this.connectionSessions.set(connectionId, sessions);
    for (const session of sessions) {
      const previousOwner = this.sessionOwners.get(session.id);
      if (previousOwner && previousOwner !== connectionId) {
        this.failPendingCommandsForOwnerChange(session.id, connectionId);
      }
      // First sight of a main session on this DO means it just became
      // remote-controllable — the only moment the session-ready push fires.
      // The durable claim in SessionIngestDO makes reconnect re-sights no-ops.
      if (!previousOwner && !session.parentSessionId && attachment.kiloUserId) {
        this.claimSessionReadyPush(attachment.kiloUserId, session.id);
      }
      this.sessionOwners.set(session.id, connectionId);
    }

    // Replay existing subscriptions for sessions newly owned by this CLI
    const previousIds = new Set(previousSessions.map(s => s.id));
    for (const session of sessions) {
      if (!previousIds.has(session.id) && this.webSubscriptions.has(session.id)) {
        this.sendToCli(ws, { type: 'subscribe', sessionId: session.id });
      }
    }

    // Update runtime registry and emit exactly one event. The event fires
    // regardless of whether sessions are present.
    let runtimeEvent: WebInboundMessage | undefined;
    if (nextRuntime) {
      const previous = this.runtimes.get(nextRuntime.runtimeId);
      if (!previous) {
        if (this.runtimes.size >= UserConnectionDO.MAX_RUNTIMES) {
          console.warn('Runtime presence rejected: registry at capacity', {
            connectionId,
            max: UserConnectionDO.MAX_RUNTIMES,
          });
          // Drop the proposed presence — do not register and do not emit. The
          // session updates above still apply, so the CLI keeps working.
          nextRuntime = undefined;
        } else {
          this.runtimes.set(nextRuntime.runtimeId, nextRuntime);
          runtimeEvent = {
            type: 'system',
            event: 'runtime.connected',
            data: { runtime: this.publicRuntime(nextRuntime) },
          };
        }
      } else if (runtimeMetadataChanged(previous, nextRuntime)) {
        this.runtimes.set(nextRuntime.runtimeId, nextRuntime);
        runtimeEvent = {
          type: 'system',
          event: 'runtime.updated',
          data: { runtime: this.publicRuntime(nextRuntime) },
        };
      } else {
        // Same metadata, same runtimeId: refresh heartbeat timestamp only.
        this.runtimes.set(nextRuntime.runtimeId, nextRuntime);
      }
    }

    // Persist to attachment for hibernation recovery
    const updatedAttachment: WSAttachment = {
      role: 'cli',
      connectionId,
      sessions,
      protocolVersion,
      kiloUserId: attachment.kiloUserId,
      ...(nextRuntime ? { runtime: nextRuntime } : {}),
    };
    ws.serializeAttachment(updatedAttachment);

    // Send heartbeat only to web clients subscribed to sessions from this connection.
    // Include subscribers for just-removed sessions so they learn the session is gone.
    const subscribers = new Set<WebSocket>();
    for (const session of sessions) {
      const subs = this.webSubscriptions.get(session.id);
      if (subs) for (const ws2 of subs) subscribers.add(ws2);
    }
    for (const prev of previousSessions) {
      if (!currentIds.has(prev.id)) {
        const subs = this.webSubscriptions.get(prev.id);
        if (subs) for (const ws2 of subs) subscribers.add(ws2);
      }
    }
    if (subscribers.size > 0) {
      const msg: WebInboundMessage = {
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId, protocolVersion, sessions },
      };
      for (const ws2 of subscribers) {
        this.sendToWeb(ws2, msg);
      }
    }

    if (runtimeEvent) {
      this.broadcastToWeb(runtimeEvent);
    }

    this.sendToCli(ws, sequence !== undefined ? { type: 'heartbeat_ack', sequence } : { type: 'heartbeat_ack' });
  }

  /**
   * Strip the internal `lastHeartbeatAt` envelope before exposing a runtime
   * outside the DO. The contract intentionally has no path.
   */
  private publicRuntime(runtime: RuntimeMetadata): LocalRuntimePresence {
    const { lastHeartbeatAt: _drop, ...publicShape } = runtime;
    return publicShape;
  }

  /**
   * Fire-and-forget "session ready to control from your phone" push via the
   * session's SessionIngestDO, which holds the durable once-ever claim.
   */
  private claimSessionReadyPush(kiloUserId: string, sessionId: string): void {
    const stub = getSessionIngestDO(this.env, { kiloUserId, sessionId });
    this.ctx.waitUntil(
      stub.claimSessionReadyPush(kiloUserId, sessionId).catch((error: unknown) => {
        console.error('Failed to claim session-ready push (non-fatal)', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  private handleCliEvent(
    sessionId: string,
    parentSessionId: string | undefined,
    event: string,
    data: unknown
  ): void {
    const childSubs = this.webSubscriptions.get(sessionId);
    const parentSubs = parentSessionId ? this.webSubscriptions.get(parentSessionId) : undefined;
    if (!childSubs && !parentSubs) return;

    const merged = new Set<WebSocket>();
    if (childSubs) for (const ws of childSubs) merged.add(ws);
    if (parentSubs) for (const ws of parentSubs) merged.add(ws);
    if (merged.size === 0) return;

    const msg: WebInboundMessage = {
      type: 'event',
      sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      event,
      data,
    };
    for (const ws of merged) {
      this.sendToWeb(ws, msg);
    }
  }

  private handleCliResponse(
    respondingWs: WebSocket,
    id: string,
    result: unknown,
    error: unknown
  ): void {
    const entry = this.pendingCommands.get(id);
    if (!entry || entry.targetCliWs !== respondingWs) return;
    this.pendingCommands.delete(id);

    // Relay-originated RPC (get_catalog): validate, cap, and settle the
    // pending Promise. Raw catalog content and CLI error strings never
    // reach the response path or the logs.
    if (entry.command === GET_CATALOG_COMMAND) {
      if (entry.pending) {
        this.settlePendingWithResult(entry.pending, result, error, {
          parse: value => localRuntimeCatalogSchema.parse(value),
          maxBytes: MAX_CATALOG_RESULT_BYTES,
          tooLargeCode: 'RESULT_TOO_LARGE',
          tooLargeMessage: 'Catalog response is too large',
          classifyError: err => this.classifyGetCatalogError(err),
        });
        return;
      }
      // No pending destination — fall through to the legacy path only as a
      // last resort (e.g. a get_catalog command snuck in via the WS path,
      // which is already blocked by COMMAND_NOT_ALLOWED upstream).
    }

    if (entry.command === CREATE_AND_RUN_COMMAND) {
      if (entry.pending) {
        this.settlePendingWithResult<CreateAndRunLocalSessionResult>(
          entry.pending,
          result,
          error,
          {
            parse: value => createAndRunLocalSessionResultSchema.parse(value),
            maxBytes: MAX_CREATE_AND_RUN_RESULT_BYTES,
            tooLargeCode: 'RESULT_TOO_LARGE',
            tooLargeMessage: 'Create-and-run response is too large',
            classifyError: err => this.classifyCreateAndRunError(err),
          }
        );
        return;
      }
    }

    if (
      (entry.command === 'list_models' || entry.command === GET_CATALOG_COMMAND) &&
      result !== undefined
    ) {
      const serializedResult = JSON.stringify(result);
      const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
      if (resultBytes > MAX_CATALOG_RESULT_BYTES) {
        if (entry.ws) {
          if (!entry.originalId) return;
          this.sendToWeb(entry.ws, {
            type: 'response',
            id: entry.originalId,
            error: CATALOG_TOO_LARGE_ERROR,
          });
        }
        return;
      }
    }

    if (!entry.ws) return;
    if (!entry.originalId) return;
    this.sendToWeb(entry.ws, {
      type: 'response',
      id: entry.originalId,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined
        ? { error: typeof error === 'string' ? error : CLI_COMMAND_ERROR }
        : {}),
    });
  }

  /**
   * Map a CLI error from a `get_catalog` response to a stable relay code.
   * The CLI's original message is intentionally not propagated; the relay
   * chooses the user-facing message and never logs the raw string.
   */
  private classifyGetCatalogError(error: unknown): LocalRuntimeCommandError {
    if (typeof error === 'string' && error.toLowerCase().includes('unknown command')) {
      return new LocalRuntimeCommandError(
        'CLI_UPGRADE_REQUIRED',
        'CLI is too old to expose a model catalog'
      );
    }
    return new LocalRuntimeCommandError('RUNTIME_COMMAND_FAILED', 'Runtime command failed');
  }

  /**
   * Map a `create_and_run` CLI error to a stable relay code. The CLI
   * reports failures as a typed `{code, message}` envelope (see
   * `RemoteSender` in the CLI). The mobile-branched codes map as follows:
   *
   * - `INVALID_REQUEST` → `INVALID_RUNTIME_RESPONSE` (the request shape
   *   the relay produced did not match the CLI's strict parser; the CLI
   *   never produced a session, so this is the same surface as a malformed
   *   runtime reply).
   * - `CATALOG_CHANGED` → `CATALOG_CHANGED` (unchanged on purpose; mobile
   *   branches on this exact code to refresh the catalog).
   * - `CREATE_FAILED` / `ANNOUNCE_FAILED` / `INTERNAL` →
   *   `RUNTIME_COMMAND_FAILED` (CLI already produced a safe, fixed-message
   *   string; the relay re-classifies to a stable, mobile-visible code
   *   without surfacing the raw message).
   *
   * Legacy CLIs that report `unknown command` (string form) collapse to
   * `CLI_UPGRADE_REQUIRED`. Any other shape collapses to the safe catch
   * all.
   */
  private classifyCreateAndRunError(error: unknown): LocalRuntimeCommandError {
    if (typeof error === 'string' && error.toLowerCase().includes('unknown command')) {
      return new LocalRuntimeCommandError(
        'CLI_UPGRADE_REQUIRED',
        'CLI is too old to create a session'
      );
    }
    if (isRecord(error) && typeof error.code === 'string') {
      switch (error.code) {
        case 'CATALOG_CHANGED':
          return new LocalRuntimeCommandError('CATALOG_CHANGED', 'Catalog request rejected');
        case 'INVALID_REQUEST':
          return new LocalRuntimeCommandError(
            'INVALID_RUNTIME_RESPONSE',
            'Runtime rejected the create-and-run request'
          );
        case 'CREATE_FAILED':
        case 'ANNOUNCE_FAILED':
        case 'INTERNAL':
          return new LocalRuntimeCommandError('RUNTIME_COMMAND_FAILED', 'Runtime command failed');
        default:
          return new LocalRuntimeCommandError('RUNTIME_COMMAND_FAILED', 'Runtime command failed');
      }
    }
    return new LocalRuntimeCommandError('RUNTIME_COMMAND_FAILED', 'Runtime command failed');
  }

  /**
   * Shared settlement path for relay-originated RPCs. The promise
   * destination is the only caller; viewer-origin responses follow the
   * legacy path below. The CLI error envelope is intentionally never
   * surfaced — the relay re-classifies to a stable code and chooses the
   * safe user-facing message.
   */
  private settlePendingWithResult<T>(
    pending: {
      resolve: (value: LocalRuntimeCatalog | CreateAndRunLocalSessionResult) => void;
      reject: (reason: LocalRuntimeCommandError) => void;
    },
    result: unknown,
    error: unknown,
    options: {
      parse: (value: unknown) => T;
      maxBytes: number;
      tooLargeCode: LocalRuntimeControlErrorCode;
      tooLargeMessage: string;
      classifyError: (error: unknown) => LocalRuntimeCommandError;
    }
  ): void {
    if (error !== undefined) {
      pending.reject(options.classifyError(error));
      return;
    }
    if (result === undefined) {
      pending.reject(
        new LocalRuntimeCommandError('INVALID_RUNTIME_RESPONSE', 'Runtime returned no result')
      );
      return;
    }
    const serializedResult = safeStringifyForSize(result);
    if (serializedResult === null) {
      pending.reject(
        new LocalRuntimeCommandError('INVALID_RUNTIME_RESPONSE', 'Result was not serializable')
      );
      return;
    }
    const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
    if (resultBytes > options.maxBytes) {
      pending.reject(new LocalRuntimeCommandError(options.tooLargeCode, options.tooLargeMessage));
      return;
    }
    try {
      const parsed = options.parse(result);
      pending.resolve(parsed as LocalRuntimeCatalog | CreateAndRunLocalSessionResult);
    } catch {
      pending.reject(
        new LocalRuntimeCommandError('INVALID_RUNTIME_RESPONSE', 'Result failed strict validation')
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Web message handling
  // ---------------------------------------------------------------------------

  private handleWebMessage(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    parsed: unknown
  ): void {
    const result = WebOutboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('Invalid web message', {
        connectionId: attachment.connectionId,
        errors: result.error.issues.map(i => i.message),
      });
      return;
    }
    const msg = result.data;

    switch (msg.type) {
      case 'subscribe':
        this.handleWebSubscribe(ws, attachment, msg.sessionId);
        break;
      case 'unsubscribe':
        this.handleWebUnsubscribe(ws, attachment, msg.sessionId);
        break;
      case 'command':
        this.handleWebCommand(ws, msg);
        break;
      case 'ping':
        this.sendToWeb(ws, { type: 'pong', nonce: msg.nonce });
        break;
    }
  }

  private handleWebSubscribe(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    sessionId: string
  ): void {
    let subs = this.webSubscriptions.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.webSubscriptions.set(sessionId, subs);
    }
    subs.add(ws);

    // Persist subscription in attachment for hibernation recovery
    if (!attachment.subscribedSessions.includes(sessionId)) {
      attachment.subscribedSessions.push(sessionId);
      ws.serializeAttachment(attachment);
    }

    this.sendToWeb(ws, {
      type: 'system',
      event: 'sessions.list',
      data: { sessions: this.aggregateSessions() },
    });

    // Tell the owning CLI to start forwarding events for this session.
    // If we know the owner (from heartbeats), send to that CLI only.
    // Otherwise broadcast to all connected CLIs — the session may be idle
    // so it wasn't reported in the most recent heartbeat.
    const cliWs = this.findCliForSession(sessionId);
    if (cliWs) {
      this.sendToCli(cliWs, { type: 'subscribe', sessionId });
    } else {
      for (const ws of this.ctx.getWebSockets('cli')) {
        this.sendToCli(ws, { type: 'subscribe', sessionId });
      }
    }
  }

  private handleWebUnsubscribe(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    sessionId: string
  ): void {
    const subs = this.webSubscriptions.get(sessionId);
    if (subs) {
      subs.delete(ws);

      // If no more subscribers, tell CLI to stop forwarding
      if (subs.size === 0) {
        this.webSubscriptions.delete(sessionId);
        const cliWs = this.findCliForSession(sessionId);
        if (cliWs) {
          this.sendToCli(cliWs, { type: 'unsubscribe', sessionId });
        }
      }
    }

    // Update attachment
    const idx = attachment.subscribedSessions.indexOf(sessionId);
    if (idx !== -1) {
      attachment.subscribedSessions.splice(idx, 1);
      ws.serializeAttachment(attachment);
    }
  }

  private handleWebCommand(
    ws: WebSocket,
    msg: { id: string; command: string; sessionId?: string; connectionId?: string; data?: unknown }
  ): void {
    const now = Date.now();
    this.expirePendingCommands(now);

    // `get_catalog` and `create_and_run` are reserved for the
    // relay-originated RPCs and are not viewer-initiated commands. Refuse
    // them explicitly so a generic viewer WebSocket cannot impersonate
    // the relay, then return before allocating any pending work.
    if (msg.command === GET_CATALOG_COMMAND || msg.command === CREATE_AND_RUN_COMMAND) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: COMMAND_NOT_ALLOWED_VIEWER_ERROR,
      });
      return;
    }

    // Find target CLI
    let targetCli: WebSocket | undefined;

    if (msg.sessionId && msg.connectionId) {
      targetCli = this.findCliByConnectionId(msg.connectionId);
      if (this.sessionOwners.get(msg.sessionId) !== msg.connectionId || !targetCli) {
        this.sendToWeb(ws, {
          type: 'response',
          id: msg.id,
          error: SESSION_OWNER_CHANGED_ERROR,
        });
        return;
      }
    } else if (msg.connectionId) {
      targetCli = this.findCliByConnectionId(msg.connectionId);
    } else if (msg.sessionId) {
      targetCli = this.findCliForSession(msg.sessionId);
    } else {
      // Fall back to first available CLI
      const cliSockets = this.ctx.getWebSockets('cli');
      targetCli = cliSockets[0];
    }

    if (!targetCli) {
      this.sendToWeb(ws, { type: 'response', id: msg.id, error: 'Session owner not found' });
      return;
    }

    const targetAttachment = targetCli.deserializeAttachment() as WSAttachment | null;
    if (targetAttachment?.role !== 'cli') return;
    const expectedOwnerConnectionId =
      msg.sessionId && msg.connectionId ? msg.connectionId : undefined;
    const targetConnectionId = targetAttachment.connectionId;

    if (
      msg.command === 'list_models' &&
      [...this.pendingCommands.values()].some(
        entry =>
          entry.ws === ws &&
          entry.command === 'list_models' &&
          entry.sessionId === msg.sessionId &&
          entry.targetConnectionId === targetConnectionId
      )
    ) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: CATALOG_REQUEST_PENDING_ERROR,
      });
      return;
    }

    if (this.pendingCommands.size >= UserConnectionDO.MAX_PENDING_COMMANDS) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: PENDING_COMMAND_LIMIT_ERROR,
      });
      return;
    }

    const correlationId = crypto.randomUUID();
    this.pendingCommands.set(correlationId, {
      ws,
      sessionId: msg.sessionId,
      originalId: msg.id,
      command: msg.command,
      expectedOwnerConnectionId,
      targetConnectionId,
      expiresAt: now + UserConnectionDO.PENDING_COMMAND_TTL_MS,
      targetCliWs: targetCli,
    });
    this.scheduleNextAlarm(now);

    this.sendToCli(targetCli, {
      type: 'command',
      id: correlationId,
      command: msg.command,
      data: msg.data,
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Disconnect handling
  // ---------------------------------------------------------------------------

  private handleCliDisconnect(
    disconnectedWs: WebSocket,
    attachment: WSAttachment & { role: 'cli' }
  ): void {
    const { connectionId } = attachment;

    // If another CLI socket already has this connectionId, this is a stale
    // close from a reconnect — the replacement socket is already active.
    const replaced = this.ctx.getWebSockets('cli').some(ws => {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      return att?.role === 'cli' && att.connectionId === connectionId;
    });

    // Fail pending commands that targeted this specific socket
    this.failPendingCommandsForSocket(disconnectedWs);

    if (replaced) {
      console.log('Stale CLI socket closed (already replaced)', { connectionId });
      return;
    }

    // Collect owned sessions before removing ownership
    const sessions = this.connectionSessions.get(connectionId) ?? [];
    const ownedSessions = new Set<string>();
    for (const session of sessions) {
      if (this.sessionOwners.get(session.id) === connectionId) {
        ownedSessions.add(session.id);
        this.sessionOwners.delete(session.id);
      }
    }
    this.connectionSessions.delete(connectionId);
    this.connectionProtocolVersion.delete(connectionId);
    this.lastHeartbeatAt.delete(connectionId);

    // Remove the runtime that was owned by this exact connection. A
    // connection's runtime is whichever entry points at this connectionId —
    // runtimes are not shared across CLIs.
    const evictedRuntimes: LocalRuntimePresence[] = [];
    for (const [runtimeId, runtime] of this.runtimes) {
      if (runtime.connectionId === connectionId) {
        this.runtimes.delete(runtimeId);
        evictedRuntimes.push(this.publicRuntime(runtime));
      }
    }

    console.log('CLI socket disconnected', {
      connectionId,
      droppedSessions: ownedSessions.size,
      droppedRuntimes: evictedRuntimes.length,
      remainingCliSockets: this.ctx.getWebSockets('cli').length,
    });

    // Leave webSubscriptions intact — a reconnecting CLI can resume

    this.broadcastToWeb({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId },
    });

    for (const runtime of evictedRuntimes) {
      this.broadcastToWeb({
        type: 'system',
        event: 'runtime.disconnected',
        data: { runtimeId: runtime.runtimeId, connectionId },
      });
    }
  }

  private handleWebDisconnect(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    const connectionId = attachment?.role === 'web' ? attachment.connectionId : 'unknown';

    // Remove from all subscription sets
    let droppedSubscriptions = 0;
    for (const [sessionId, subs] of this.webSubscriptions) {
      if (!subs.has(ws)) continue;
      subs.delete(ws);
      droppedSubscriptions++;

      if (subs.size === 0) {
        this.webSubscriptions.delete(sessionId);
        // Tell owning CLI to stop forwarding
        const cliWs = this.findCliForSession(sessionId);
        if (cliWs) {
          this.sendToCli(cliWs, { type: 'unsubscribe', sessionId });
        }
      }
    }

    // Clean up any pending commands from this web socket
    let droppedCommands = 0;
    for (const [id, entry] of this.pendingCommands) {
      if (entry.ws === ws) {
        this.pendingCommands.delete(id);
        droppedCommands++;
      }
    }

    console.log('Web socket disconnected', {
      connectionId,
      droppedSubscriptions,
      droppedCommands,
      remainingWebSockets: this.ctx.getWebSockets('web').length,
    });
  }

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  getActiveSessions(): Array<
    HeartbeatSession & { connectionId: string; protocolVersion?: string }
  > {
    this.ensureState();
    return this.aggregateSessions();
  }

  /**
   * Public, read-only list of every first-class runtime the DO currently
   * tracks. Runtimes with empty session arrays and runtimes that lost a
   * required capability (e.g. CLI upgrade not yet shipped) are both
   * included so mobile can render a precise recovery surface.
   */
  getRuntimePresence(): LocalRuntimePresence[] {
    this.ensureState();
    return [...this.runtimes.values()].map(r => this.publicRuntime(r));
  }

  /**
   * Relay-originated catalog fetch. The exact runtime (runtimeId +
   * connectionId) is validated against the live socket and capability set
   * BEFORE any pending work is allocated, so a misrouted call never
   * reaches the CLI. The command is sent to the exact CLI socket, never a
   * fallback. The Promise settles when the targeted CLI replies, the
   * pending TTL elapses, the runtime disconnects, or the runtime is
   * replaced — each with a stable, mobile-branched error code.
   */
  async getRuntimeCatalog(fence: LocalRuntimeFence): Promise<LocalRuntimeCatalog> {
    return this.dispatchRuntimeCommand<LocalRuntimeCatalog>(fence, {
      command: GET_CATALOG_COMMAND,
      requiredCapability: 'catalog.v1',
      commandData: { protocolVersion: 1 },
    });
  }

  /**
   * Relay-originated sessionless create-and-run. The same private
   * dispatcher validates the exact runtimeId+connectionId fence and the
   * `create-and-run.v1` capability, routes the strict request to the
   * exact CLI socket, and rejects wrong-socket responses. The Promise
   * settles on the CLI's typed success/partial result, an unknown
   * command, the typed CLI error envelope, a pending TTL expiry, or a
   * disconnect/replacement — each with a stable, mobile-branched code.
   *
   * The CLI is the authority on the session ID and prompt-start outcome;
   * the DO NEVER mints, mutates, or fabricates the session ID. The
   * strict result parser uses the cloud-owned `sessionIdSchema`, so a CLI
   * that reports anything other than a `ses_…` ID is rejected as
   * `INVALID_RUNTIME_RESPONSE`.
   */
  async createAndRunLocalSession(
    fence: LocalRuntimeFence,
    request: CreateAndRunLocalSessionRequest
  ): Promise<CreateAndRunLocalSessionResult> {
    // The request is parsed at the boundary. The CLI re-validates against
    // the same schema, but the DO also parses so a misrouted or
    // duplicated request can fail closed before the CLI sees it.
    const parsedRequest = createAndRunLocalSessionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new LocalRuntimeCommandError(
        'INVALID_RUNTIME_RESPONSE',
        'Create-and-run request failed strict validation'
      );
    }

    return this.dispatchRuntimeCommand<CreateAndRunLocalSessionResult>(fence, {
      command: CREATE_AND_RUN_COMMAND,
      requiredCapability: 'create-and-run.v1',
      commandData: parsedRequest.data,
    });
  }

  /**
   * Private dispatcher shared by `getRuntimeCatalog` and
   * `createAndRunLocalSession`. It validates the fence and the required
   * capability against the live socket BEFORE any pending work is
   * allocated, so a misrouted or capability-mismatched call never
   * reaches the CLI. The command is sent to the exact CLI socket, never
   * a fallback. The Promise settles when the targeted CLI replies, the
   * pending TTL elapses, the runtime disconnects, or the runtime is
   * replaced — each with a stable, mobile-branched error code.
   */
  private async dispatchRuntimeCommand<T>(
    fence: LocalRuntimeFence,
    options: {
      command: string;
      requiredCapability: 'catalog.v1' | 'create-and-run.v1';
      commandData: unknown;
    }
  ): Promise<T> {
    this.ensureState();
    const now = Date.now();
    this.expirePendingCommands(now);

    // Exact runtimeId lookup. A missing runtimeId means the runtime was
    // never seen or has been evicted — the safe mobile state is to refresh
    // the list and pick another runtime, so surface NOT_FOUND.
    const runtime = this.runtimes.get(fence.runtimeId);
    if (!runtime) {
      throw new LocalRuntimeCommandError(
        'RUNTIME_NOT_CONNECTED',
        'Runtime is not currently connected'
      );
    }

    // Fence must point at the live socket that owns the runtime. A live
    // socket is required so we have a target to send the command to.
    if (runtime.connectionId !== fence.connectionId) {
      throw new LocalRuntimeCommandError(
        'RUNTIME_FENCE_MISMATCH',
        'Runtime is owned by a different connection'
      );
    }
    if (!runtime.capabilities.includes(options.requiredCapability)) {
      throw new LocalRuntimeCommandError(
        'RUNTIME_FENCE_MISMATCH',
        `Runtime does not advertise the ${options.requiredCapability} capability`
      );
    }

    const targetCli = this.findCliByConnectionId(fence.connectionId);
    if (!targetCli) {
      throw new LocalRuntimeCommandError(
        'RUNTIME_FENCE_MISMATCH',
        'Runtime socket is not currently connected'
      );
    }

    if (this.pendingCommands.size >= UserConnectionDO.MAX_PENDING_COMMANDS) {
      throw new LocalRuntimeCommandError(
        'PENDING_COMMAND_LIMIT',
        'Too many pending commands'
      );
    }

    const correlationId = crypto.randomUUID();
    const promise = new Promise<T>((resolve, reject) => {
      this.pendingCommands.set(correlationId, {
        pending: {
          resolve: resolve as (
            value: LocalRuntimeCatalog | CreateAndRunLocalSessionResult
          ) => void,
          reject,
        },
        command: options.command,
        targetConnectionId: fence.connectionId,
        expiresAt: now + UserConnectionDO.PENDING_COMMAND_TTL_MS,
        targetCliWs: targetCli,
      });
    });
    this.scheduleNextAlarm(now);

    this.sendToCli(targetCli, {
      type: 'command',
      id: correlationId,
      command: options.command,
      data: options.commandData,
    });

    return promise;
  }

  async notifySessionEvent(event: SessionEventPayload): Promise<{ delivered: number }> {
    this.ensureState();
    const parsed = SessionEventPayloadSchema.parse(event);
    const msg: WebInboundMessage = {
      type: 'system',
      event: parsed.type,
      data: parsed.data,
    };

    let delivered = 0;
    const json = JSON.stringify(msg);
    for (const ws of this.activeWebSockets()) {
      try {
        ws.send(json);
        delivered++;
      } catch (err) {
        console.warn('notifySessionEvent: skipping failed web socket:', err);
      }
    }
    return { delivered };
  }

  hasActiveCliSession(sessionId: string): boolean {
    this.ensureState();
    return this.findCliForSession(sessionId) !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sendToCli(ws: WebSocket, msg: CLIInboundMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('sendToCli failed:', err);
    }
  }

  private sendToWeb(ws: WebSocket, msg: WebInboundMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('sendToWeb failed:', err);
    }
  }

  private broadcastToWeb(msg: WebInboundMessage, exclude?: WebSocket): void {
    const json = JSON.stringify(msg);
    for (const ws of this.activeWebSockets()) {
      if (ws !== exclude) {
        try {
          ws.send(json);
        } catch (err) {
          console.warn('broadcastToWeb: skipping failed socket:', err);
        }
      }
    }
  }

  /** Close a stale CLI socket that has the same connectionId (from a previous connection). Returns true if one was found. */
  private closeStaleSocket(connectionId: string): boolean {
    for (const ws of this.ctx.getWebSockets('cli')) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.role === 'cli' && att.connectionId === connectionId) {
        console.log('Closing stale CLI socket for reconnect', { connectionId });
        this.failPendingCommandsForSocket(ws);
        // Preserve session ownership — the reconnecting CLI still owns these sessions
        ws.close(1000, 'replaced by reconnect');
        return true;
      }
    }
    return false;
  }

  private replaceWebSocket(connectionId: string): void {
    for (const ws of this.ctx.getWebSockets('web')) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (
        attachment?.role !== 'web' ||
        attachment.connectionId !== connectionId ||
        attachment.replaced
      ) {
        continue;
      }

      ws.serializeAttachment({ ...attachment, replaced: true });
      this.handleWebDisconnect(ws);
      ws.close(1000, 'replaced by reconnect');
    }
  }

  private activeWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets('web').filter(ws => {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      return attachment?.role === 'web' && !attachment.replaced;
    });
  }

  private findCliForSession(sessionId: string): WebSocket | undefined {
    const ownerConnectionId = this.sessionOwners.get(sessionId);
    if (!ownerConnectionId) return undefined;
    return this.findCliByConnectionId(ownerConnectionId);
  }

  private findCliByConnectionId(connectionId: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets('cli')) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (attachment?.role === 'cli' && attachment.connectionId === connectionId) {
        return ws;
      }
    }
    return undefined;
  }

  private failPendingCommandsForSocket(targetWs: WebSocket): void {
    for (const [id, entry] of this.pendingCommands) {
      if (entry.targetCliWs !== targetWs) continue;
      this.pendingCommands.delete(id);
      if (entry.pending) {
        entry.pending.reject(
          new LocalRuntimeCommandError(
            'RUNTIME_FENCE_MISMATCH',
            entry.expectedOwnerConnectionId
              ? 'Session owner changed before runtime command could be read'
              : 'Runtime disconnected before runtime command could be read'
          )
        );
        continue;
      }
      if (!entry.ws) continue;
      if (!entry.originalId) continue;
      this.sendToWeb(entry.ws, {
        type: 'response',
        id: entry.originalId,
        error: entry.expectedOwnerConnectionId ? SESSION_OWNER_CHANGED_ERROR : 'CLI disconnected',
      });
    }
  }

  private failPendingCommandsForOwnerChange(
    sessionId: string,
    nextOwnerConnectionId: string | undefined
  ): void {
    for (const [id, entry] of this.pendingCommands) {
      if (entry.sessionId !== sessionId || entry.targetConnectionId === nextOwnerConnectionId) {
        continue;
      }
      this.pendingCommands.delete(id);
      if (entry.pending) {
        entry.pending.reject(
          new LocalRuntimeCommandError(
            'RUNTIME_FENCE_MISMATCH',
            'Session owner changed before command completed'
          )
        );
        continue;
      }
      if (!entry.ws) continue;
      if (!entry.originalId) continue;
      this.sendToWeb(entry.ws, {
        type: 'response',
        id: entry.originalId,
        error: SESSION_OWNER_CHANGED_ERROR,
      });
    }
  }

  private expirePendingCommands(now: number): void {
    for (const [id, entry] of this.pendingCommands) {
      if (entry.expiresAt > now) continue;
      this.pendingCommands.delete(id);
      if (entry.pending) {
        entry.pending.reject(
          new LocalRuntimeCommandError('COMMAND_EXPIRED', 'Command expired before response')
        );
        continue;
      }
      if (!entry.ws) continue;
      if (!entry.originalId) continue;
      this.sendToWeb(entry.ws, {
        type: 'response',
        id: entry.originalId,
        error: COMMAND_EXPIRED_ERROR,
      });
    }
  }

  private scheduleNextAlarm(now: number): void {
    let nextAlarmAt: number | undefined;

    for (const lastSeen of this.lastHeartbeatAt.values()) {
      const staleAt = lastSeen + UserConnectionDO.HEARTBEAT_TIMEOUT_MS;
      if (staleAt > now && (nextAlarmAt === undefined || staleAt < nextAlarmAt)) {
        nextAlarmAt = staleAt;
      }
    }

    for (const entry of this.pendingCommands.values()) {
      if (entry.expiresAt > now && (nextAlarmAt === undefined || entry.expiresAt < nextAlarmAt)) {
        nextAlarmAt = entry.expiresAt;
      }
    }

    if (nextAlarmAt !== undefined) {
      void this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }

  private aggregateSessions(): Array<
    HeartbeatSession & { connectionId: string; protocolVersion?: string }
  > {
    // Build set of connectionIds that still have a live CLI WebSocket.
    // This guards against stale entries that persist if a close event is delayed.
    const liveConnectionIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets('cli')) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.role === 'cli') liveConnectionIds.add(att.connectionId);
    }

    const result: Array<HeartbeatSession & { connectionId: string; protocolVersion?: string }> = [];
    for (const [connectionId, sessions] of this.connectionSessions) {
      if (!liveConnectionIds.has(connectionId)) continue;
      const protocolVersion = this.connectionProtocolVersion.get(connectionId);
      for (const session of sessions) {
        if (session.parentSessionId) continue;
        result.push({ ...session, connectionId, ...(protocolVersion ? { protocolVersion } : {}) });
      }
    }
    return result;
  }
}

function runtimeMetadataChanged(previous: RuntimeMetadata, next: RuntimeMetadata): boolean {
  return (
    previous.cliVersion !== next.cliVersion ||
    previous.displayName !== next.displayName ||
    previous.projectName !== next.projectName ||
    !capabilitiesEqual(previous.capabilities, next.capabilities) ||
    previous.protocolVersion !== next.protocolVersion
  );
}

function capabilitiesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function safeStringifyForSize(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getUserConnectionDO(env: Env, params: { kiloUserId: string }) {
  const id = env.USER_CONNECTION_DO.idFromName(params.kiloUserId);
  return env.USER_CONNECTION_DO.get(id);
}
