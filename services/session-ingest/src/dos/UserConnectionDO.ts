import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { getSessionIngestDO } from './SessionIngestDO';
import { resolveAccessibleKiloSession } from '../services/session-access';
import {
  CLIOutboundMessageSchema,
  type CLIInboundMessage,
  type Instance,
  type SessionEventPayload,
  SessionEventPayloadSchema,
  type WebInboundMessage,
  WebOutboundMessageSchema,
} from '../types/user-connection-protocol';

type HeartbeatSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
  parentSessionId?: string;
  // Platform the session is running on (e.g. "darwin", "linux", "vscode").
  // Optional: legacy CLIs (predating the `kilo remote` spawner) do not
  // report a platform; in that case this field is undefined and the
  // `getActiveSessions()` response omits it (preserves byte-identical
  // legacy responses).
  platform?: string;
  // Pull-request link reported by the CLI. Optional: legacy CLIs predating
  // this field omit it. Distinct from `platform` above (the client OS).
  prLink?: {
    platform: string;
    prUrl: string;
    prNumber: number;
  };
};

type ConnectionCapabilities = { attachments?: boolean };

type WSAttachment =
  | {
      role: 'cli';
      connectionId: string;
      sessions: HeartbeatSession[];
      // Undefined means no protocolVersion has been reported yet — either the
      // CLI hasn't sent its first heartbeat, or it's a legacy build that
      // predates this field entirely. Both cases fall back to legacy behavior.
      protocolVersion?: string;
      // Latest capabilities advertised by this connection. Undefined means
      // either the CLI hasn't sent its first heartbeat, or it's a legacy
      // build that predates the capabilities field — both surface as no
      // opt-in features.
      capabilities?: ConnectionCapabilities;
      // Set from the authenticated /user/cli route; undefined on sockets
      // accepted before this field existed. Needed for the session-ready push.
      kiloUserId?: string;
      // Identity of the spawning CLI process (`kilo remote`). Undefined on
      // legacy CLIs (no spawner). Persisted in the attachment so the live
      // socket scan in `getConnectedInstances()` can read it without any
      // in-memory map or hibernation reconstruction — keeps the response
      // fresh and avoids stale instance rows on restart.
      instance?: Instance;
    }
  | {
      role: 'web';
      connectionId: string;
      subscribedSessions: string[];
      replaced?: true;
      // Set from the authenticated /user/web route; undefined on sockets
      // accepted before this field existed. Needed for command/subscribe
      // access rechecks against current session membership.
      kiloUserId?: string;
    };

// Type re-export so test files and other internal callers can reference the
// connection-row shape from a single place.
export type ConnectedInstanceRow = {
  connectionId: string;
  name: string;
  projectName: string;
  version?: string;
  // Latest capabilities from the CLI socket attachment. Omitted when the
  // attachment has no capabilities (legacy CLI / pre-field build) so the
  // response stays byte-identical for those clients.
  capabilities?: ConnectionCapabilities;
};

export const MAX_CATALOG_RESULT_BYTES = 512 * 1024;

// Maximum durable result size before truncation. Results larger than this are
// replaced with a size-exceeded marker before the storage.put so the DO value
// limit (128 KiB) is never hit. 120 KiB leaves generous headroom for the
// serialized PendingCommandEntry framing overhead while preserving enough
// payload for most retry scenarios.
export const MAX_DURABLE_RESULT_BYTES = 120 * 1024;

// Maximum allowed mutationId length used as a durable storage key prefix.
const MAX_MUTATION_ID_LENGTH = 128;

// Viewer command allowlist. Anything outside this set is rejected by the relay
// before owner resolution, pending allocation, or CLI forwarding.
export const ALLOWED_VIEWER_COMMANDS: ReadonlySet<string> = new Set([
  'send_message',
  'interrupt',
  'question_reply',
  'question_reject',
  'permission_respond',
  'suggestion_accept',
  'suggestion_dismiss',
  'list_models',
  'list_commands',
  'send_command',
  'create_session',
  'exit_cli',
]);

// In-flight dedupe and 512 KiB response cap apply to these catalog-style reads.
const CATALOG_DEDUPE_COMMANDS: ReadonlySet<string> = new Set(['list_models', 'list_commands']);

// Operations that older CLIs reject with a precise "unknown command: <op>"
// string. Only these commands get mapped to a structured CLI_UPGRADE_REQUIRED
// response; any other CLI error is preserved verbatim.
const CLI_UPGRADE_REQUIRED_COMMANDS: ReadonlySet<string> = new Set([
  'list_commands',
  'send_command',
  'create_session',
  'exit_cli',
]);

const SESSION_OWNER_CHANGED_ERROR = {
  source: 'relay',
  code: 'SESSION_OWNER_CHANGED',
  message: 'Session owner changed',
};

const SESSION_ACCESS_DENIED_ERROR = {
  source: 'relay',
  code: 'SESSION_ACCESS_DENIED',
  message: 'You no longer have access to this session',
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

const COMMAND_NOT_ALLOWED_ERROR = {
  source: 'relay',
  code: 'COMMAND_NOT_ALLOWED',
  message: 'Command is not allowed',
};

const INVALID_COMMAND_ERROR = {
  source: 'relay',
  code: 'INVALID_COMMAND',
  message: 'Invalid command',
};

const CLI_UPGRADE_REQUIRED_SLASH_ERROR = {
  source: 'relay',
  code: 'CLI_UPGRADE_REQUIRED',
  message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
};

const CLI_UPGRADE_REQUIRED_CREATE_SESSION_ERROR = {
  source: 'relay',
  code: 'CLI_UPGRADE_REQUIRED',
  message:
    'Creating remote sessions from mobile requires a newer Kilo CLI. Update Kilo CLI and reconnect.',
};

const CLI_COMMAND_ERROR = {
  source: 'cli',
  message: 'Command failed',
};

const DURABLE_RESULT_TOO_LARGE_ERROR = {
  source: 'relay',
  code: 'DURABLE_RESULT_TOO_LARGE',
  message: 'Result is too large to store for retries',
};

const MUTATION_ID_TOO_LONG_ERROR = {
  source: 'relay',
  code: 'MUTATION_ID_TOO_LONG',
  message: 'Mutation ID is too long',
};

type ReadyPushEntry = {
  kiloUserId: string;
  title: string;
  fireAt: number;
  attempts: number;
};

type RenameEntry = {
  title: string;
  at: number;
};

type PendingCommandEntry = {
  sessionId?: string;
  originalId: string;
  command: string;
  expectedOwnerConnectionId?: string;
  targetConnectionId: string;
  expiresAt: number;
  // The originating web socket's connectionId (from attachment).
  // Stable across hibernation; used to resolve the socket on wake.
  webConnectionId: string;
  // D8 state: 'pending' or 'done'. When 'done', result or error holds the outcome.
  state: 'pending' | 'done';
  result?: unknown;
  error?: unknown;
};

const READY_PUSH_KEY_PREFIX = 'readyPush:';
const RENAME_KEY_PREFIX = 'rename:';
const PENDING_COMMAND_KEY_PREFIX = 'pendingCommand/';
const SESSION_READY_PUSH_DELAY_MS = 5_000;
/** Backoff between ready-push claim retries so the 3-attempt bound spans real time. */
const READY_PUSH_RETRY_BACKOFF_MS = 5_000;
const READY_PUSH_MAX_ATTEMPTS = 3;
/** Drop offline rename catch-up entries that never matched a heartbeat title. */
const RENAME_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class UserConnectionDO extends DurableObject<Env> {
  private static readonly HEARTBEAT_TIMEOUT_MS = 30_000;
  private static readonly PENDING_COMMAND_TTL_MS = 35_000;
  private static readonly MAX_PENDING_COMMANDS = 128;

  // Which CLI connection owns each session
  private sessionOwners = new Map<string, string>();
  // Which web sockets want events for a session
  private webSubscriptions = new Map<string, Set<WebSocket>>();
  // Sessions per CLI connection (from heartbeat)
  private connectionSessions = new Map<string, HeartbeatSession[]>();
  // Protocol version per CLI connection (from heartbeat); absent = legacy CLI
  private connectionProtocolVersion = new Map<string, string | undefined>();
  // Capabilities per CLI connection (from heartbeat); absent = legacy CLI
  private connectionCapabilities = new Map<string, ConnectionCapabilities | undefined>();
  // Pending command responses: correlationId → originating web socket
  private pendingCommands = new Map<
    string,
    {
      ws: WebSocket;
      sessionId?: string;
      originalId: string;
      command: string;
      expectedOwnerConnectionId?: string;
      targetConnectionId: string;
      expiresAt: number;
      targetCliWs: WebSocket;
    }
  >();
  private pendingInitialCommandWrites = new Set<string>();
  private terminalDuringInitialWrite = new Map<string, PendingCommandEntry>();
  // Last heartbeat timestamp per CLI connectionId (for staleness eviction)
  private lastHeartbeatAt = new Map<string, number>();
  // In-memory mirror of readyPush KV fireAt values — scheduling only; KV is source of truth
  private readyPushFireAt = new Map<string, number>();
  // One-shot post-eviction rebuild gate; reset whenever ensureState actually reconstructs
  private readyPushRebuilt = false;

  // Synchronous reservation set for mutationId dedupe (prevents concurrent same-ID dispatch
  // across asynchronous storage reads in the mutationId path).
  private inflightMutations = new Set<string>();

  // Synchronous completion set for CLI responses already delivered live.
  // Prevents the rehydration path from delivering a duplicate response while the
  // durable write to 'done' is still in-flight.
  private completedCorrelationIds = new Set<string>();

  private stateReconstructed = false;

  private ensureState(): void {
    if (this.stateReconstructed) return;

    let cliCount = 0;
    let webCount = 0;
    let sessionCount = 0;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (!attachment) continue;

      if (attachment.role === 'cli') {
        cliCount++;
        const { connectionId, sessions, protocolVersion, capabilities } = attachment;
        this.connectionSessions.set(connectionId, sessions);
        this.connectionProtocolVersion.set(connectionId, protocolVersion);
        this.connectionCapabilities.set(connectionId, capabilities);
        sessionCount += sessions.length;
        for (const session of sessions) {
          this.sessionOwners.set(session.id, connectionId);
        }
        this.lastHeartbeatAt.set(connectionId, Date.now());
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
      subscriptions: this.webSubscriptions.size,
    });

    this.stateReconstructed = true;
    // Fresh reconstruction must re-list readyPush KV once for scheduling.
    this.readyPushRebuilt = false;
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
      const attachment: WSAttachment = {
        role: 'cli',
        connectionId,
        sessions: [],
        kiloUserId,
      };
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

      const kiloUserId = url.searchParams.get('kiloUserId') ?? undefined;
      const attachment: WSAttachment = {
        role: 'web',
        connectionId,
        subscribedSessions: [],
        kiloUserId,
      };
      this.ctx.acceptWebSocket(server, ['web']);
      server.serializeAttachment(attachment);

      const sessions = this.aggregateSessions();

      console.log('Web socket connected', {
        connectionId,
        totalWebSockets: this.ctx.getWebSockets('web').length,
        activeSessions: sessions.length,
      });

      this.sendToWeb(server, {
        type: 'system',
        event: 'sessions.list',
        data: { sessions },
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      await this.handleWebMessage(ws, attachment, parsed);
    }
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): void | Promise<void> {
    this.ensureState();

    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    if (!attachment) return;

    if (attachment.role === 'cli') {
      // Await attention resets so cli.disconnected is not broadcast until the
      // stored status write has committed (mobile history refetch races otherwise).
      return this.handleCliDisconnect(ws, attachment);
    }
    this.handleWebDisconnect(ws);
  }

  webSocketError(ws: WebSocket): void | Promise<void> {
    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    console.error('WebSocket error', {
      role: attachment?.role ?? 'unknown',
      connectionId: attachment?.connectionId ?? 'unknown',
    });
    return this.webSocketClose(ws, 0, '', false);
  }

  async alarm(): Promise<void> {
    this.ensureState();

    const now = Date.now();
    this.expirePendingCommands(now);
    await this.fireReadyPushes(now);
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
          console.log('Closing stale CLI connection (heartbeat timeout)', {
            connectionId,
          });
          ws.close(4408, 'heartbeat timeout');
          break;
        }
      }
      // handleCliDisconnect will clean up connectionSessions/sessionOwners/lastHeartbeatAt
      // via the webSocketClose callback
    }

    this.scheduleNextAlarm(now);
    this.scheduleDurablePendingAlarm();
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
        issues: result.error.issues.map(issue => ({
          path: issue.path,
          code: issue.code,
        })),
      });
      return;
    }
    const msg = result.data;

    switch (msg.type) {
      case 'heartbeat':
        this.handleHeartbeat(
          ws,
          attachment,
          msg.sessions,
          msg.protocolVersion,
          msg.capabilities,
          msg.instance
        );
        break;
      case 'event':
        this.handleCliEvent(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
        break;
      case 'response':
        // Extend the DO lifetime for the async durable write (fix: reply
        // must persist before hibernation, but the surrounding handler stays
        // synchronous for existing callers).
        // Catches storage read/write failures so the waitUntil task is
        // never left unhandled (rejected).
        this.ctx.waitUntil(
          this.handleCliResponse(ws, msg.id, msg.result, msg.error).catch((error: unknown) => {
            console.error('Failed to handle CLI response (non-fatal)', {
              correlationId: msg.id,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        );
        break;
    }
  }

  private handleHeartbeat(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'cli' },
    sessions: HeartbeatSession[],
    protocolVersion: string | undefined,
    capabilities: ConnectionCapabilities | undefined,
    instance: Instance | undefined
  ): void {
    const { connectionId } = attachment;
    const now = Date.now();
    this.lastHeartbeatAt.set(connectionId, now);
    this.connectionProtocolVersion.set(connectionId, protocolVersion);
    this.connectionCapabilities.set(connectionId, capabilities);
    this.scheduleNextAlarm(now);

    // Remove sessions this connection previously owned but no longer reports
    const previousSessions = this.connectionSessions.get(connectionId) ?? [];
    const currentIds = new Set(sessions.map(s => s.id));
    for (const prev of previousSessions) {
      if (!currentIds.has(prev.id) && this.sessionOwners.get(prev.id) === connectionId) {
        this.sessionOwners.delete(prev.id);
        this.ctx.waitUntil(
          this.failPendingCommandsForOwnerChange(prev.id, undefined).catch((error: unknown) => {
            console.error('Failed to persist terminal commands for dropped session', {
              sessionId: prev.id,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        );
      }
    }

    // Update ownership
    this.connectionSessions.set(connectionId, sessions);
    for (const session of sessions) {
      const previousOwner = this.sessionOwners.get(session.id);
      if (previousOwner && previousOwner !== connectionId) {
        this.ctx.waitUntil(
          this.failPendingCommandsForOwnerChange(session.id, connectionId).catch(
            (error: unknown) => {
              console.error('Failed to persist terminal commands for owner change', {
                sessionId: session.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          )
        );
      }
      // First sight of a main session on this DO: schedule a delayed session-ready
      // push (Decision 9). The durable claim in SessionIngestDO makes reconnect
      // re-sights no-ops once the delayed claim lands.
      if (!previousOwner && !session.parentSessionId && attachment.kiloUserId) {
        this.scheduleSessionReadyPush(attachment.kiloUserId, session.id, session.title);
      }
      this.sessionOwners.set(session.id, connectionId);
    }

    // Offline rename catch-up: re-emit stored renames whose heartbeat title still
    // differs; delete entries once the CLI title matches (self-cleaning).
    // Lazy KV read per heartbeat (no in-memory rename mirror). Keep alive via
    // waitUntil so the DO does not hibernate before catch-up finishes.
    this.ctx.waitUntil(
      this.catchUpPendingRenames(ws, sessions).catch((error: unknown) => {
        console.error('Failed to catch up pending renames (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );

    // Replay existing subscriptions for sessions newly owned by this CLI
    const previousIds = new Set(previousSessions.map(s => s.id));
    for (const session of sessions) {
      if (!previousIds.has(session.id) && this.webSubscriptions.has(session.id)) {
        this.sendToCli(ws, { type: 'subscribe', sessionId: session.id });
      }
    }

    // Persist to attachment for hibernation recovery
    const updatedAttachment: WSAttachment = {
      role: 'cli',
      connectionId,
      sessions,
      protocolVersion,
      capabilities,
      kiloUserId: attachment.kiloUserId,
      ...(instance ? { instance } : {}),
    };
    ws.serializeAttachment(updatedAttachment);

    // Broadcast the heartbeat to every one of the user's web sockets. Subscribers
    // and non-subscribers both receive it: a removed session id is detectable
    // from its absence in the payload, so no subscriber special-case is needed.
    this.broadcastToWeb({
      type: 'system',
      event: 'sessions.heartbeat',
      data: {
        connectionId,
        protocolVersion,
        capabilities,
        sessions: sessions.map(session => ({
          ...session,
          ...(capabilities ? { capabilities } : {}),
        })),
      },
    });

    this.sendToCli(ws, { type: 'heartbeat_ack' });
  }

  /**
   * Schedule a delayed session-ready push: KV put (awaited) then arm alarm.
   * All inside waitUntil so the heartbeat path stays sync.
   * No-op when a pending entry already exists (mirror or KV) so reconnect
   * first-sights do not slide fireAt or reset attempts.
   */
  private scheduleSessionReadyPush(kiloUserId: string, sessionId: string, title: string): void {
    if (this.readyPushFireAt.has(sessionId)) return;

    const key = `${READY_PUSH_KEY_PREFIX}${sessionId}`;
    this.ctx.waitUntil(
      (async () => {
        const existing = await this.ctx.storage.get<ReadyPushEntry>(key);
        if (existing) {
          this.readyPushFireAt.set(sessionId, existing.fireAt);
          this.scheduleNextAlarm(Date.now());
          return;
        }
        const fireAt = Date.now() + SESSION_READY_PUSH_DELAY_MS;
        await this.ctx.storage.put(key, {
          kiloUserId,
          title,
          fireAt,
          attempts: 0,
        } satisfies ReadyPushEntry);
        this.readyPushFireAt.set(sessionId, fireAt);
        this.scheduleNextAlarm(Date.now());
      })().catch((error: unknown) => {
        console.error('Failed to schedule session-ready push (non-fatal)', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  /**
   * Await the SessionIngestDO claim. Rejects on DO/transport failure — the
   * throw class the ready-push retry bound covers. Notification-dispatch
   * failures are swallowed inside SessionIngestDO (unchanged).
   */
  private async claimSessionReadyPush(
    kiloUserId: string,
    sessionId: string,
    title?: string
  ): Promise<void> {
    const stub = getSessionIngestDO(this.env, { kiloUserId, sessionId });
    await stub.claimSessionReadyPush(kiloUserId, sessionId, title);
  }

  private async fireReadyPushes(now: number): Promise<void> {
    let pending: Map<string, ReadyPushEntry>;
    try {
      pending = await this.ctx.storage.list<ReadyPushEntry>({
        prefix: READY_PUSH_KEY_PREFIX,
      });
    } catch (error: unknown) {
      console.error('Failed to list readyPush entries', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const [key, entry] of pending) {
      if (!entry || typeof entry.fireAt !== 'number') continue;
      if (entry.fireAt > now) continue;

      const sessionId = key.slice(READY_PUSH_KEY_PREFIX.length);
      if (!sessionId) continue;

      // Freshest title: heartbeat title only if it exists and differs from stored;
      // else undefined so notifications falls back to the live DB title.
      const heartbeatTitle = this.findHeartbeatTitle(sessionId);
      const freshest =
        heartbeatTitle !== undefined && heartbeatTitle !== entry.title ? heartbeatTitle : undefined;

      try {
        await this.claimSessionReadyPush(entry.kiloUserId, sessionId, freshest);
        await this.ctx.storage.delete(key);
        this.readyPushFireAt.delete(sessionId);
      } catch (error: unknown) {
        const attempts = (entry.attempts ?? 0) + 1;
        if (attempts >= READY_PUSH_MAX_ATTEMPTS) {
          await this.ctx.storage.delete(key);
          this.readyPushFireAt.delete(sessionId);
          console.error('Dropping session-ready push after max attempts', {
            sessionId,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          const fireAt = now + READY_PUSH_RETRY_BACKOFF_MS;
          await this.ctx.storage.put(key, { ...entry, attempts, fireAt });
          this.readyPushFireAt.set(sessionId, fireAt);
          console.error('Session-ready push claim failed; will retry', {
            sessionId,
            attempts,
            fireAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private findHeartbeatTitle(sessionId: string): string | undefined {
    for (const sessions of this.connectionSessions.values()) {
      for (const session of sessions) {
        if (session.id === sessionId) return session.title;
      }
    }
    return undefined;
  }

  private async catchUpPendingRenames(ws: WebSocket, sessions: HeartbeatSession[]): Promise<void> {
    const now = Date.now();
    for (const session of sessions) {
      const key = `${RENAME_KEY_PREFIX}${session.id}`;
      let entry: RenameEntry | undefined;
      try {
        entry = await this.ctx.storage.get<RenameEntry>(key);
      } catch (error: unknown) {
        console.error('Failed to read rename catch-up entry', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!entry) continue;

      // Prune entries past TTL so finished/ignored renames do not re-emit forever.
      if (typeof entry.at === 'number' && now - entry.at > RENAME_ENTRY_TTL_MS) {
        try {
          await this.ctx.storage.delete(key);
        } catch (error: unknown) {
          console.error('Failed to delete expired rename entry', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      if (session.title === entry.title) {
        try {
          await this.ctx.storage.delete(key);
        } catch (error: unknown) {
          console.error('Failed to delete matched rename entry', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      this.sendToCli(ws, {
        type: 'system',
        event: 'session.renamed',
        data: { sessionId: session.id, title: entry.title },
      });
    }
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

  private async handleCliResponse(
    respondingWs: WebSocket,
    id: string,
    result: unknown,
    error: unknown
  ): Promise<void> {
    let entry = this.pendingCommands.get(id);
    let rehydrated = false;
    // Captured at the first durable read so the catalog-too-large branch
    // does not need a second read (fix: second read can return undefined
    // and abandon terminal processing).
    let rehydratedDurable: PendingCommandEntry | undefined;
    let ownsReservation = false;

    // Step 24: on in-memory miss, try to load the durable entry (D8 case 1).
    if (!entry) {
      // Synchronously reserve the correlationId before the async durable
      // read so a concurrent duplicate CLI reply cannot also process the
      // same pending durable state after a wake.
      if (this.completedCorrelationIds.has(id)) return;
      this.completedCorrelationIds.add(id);
      ownsReservation = true;

      try {
        const durable = await this.getDurablePendingCommand(id);
        if (!durable || durable.state !== 'pending') {
          this.completedCorrelationIds.delete(id);
          ownsReservation = false;
          return;
        }
        rehydratedDurable = durable;

        // Guard: a rehydrated entry that has already expired must not deliver
        // or persist a late success outcome. Write the terminal expiry error
        // durably and return without delivering.
        if (durable.expiresAt <= Date.now()) {
          await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, {
            ...durable,
            state: 'done',
            error: COMMAND_EXPIRED_ERROR,
          });
          // Reservation held through the terminal write; clear after success.
          this.completedCorrelationIds.delete(id);
          ownsReservation = false;
          return;
        }

        // Validate the responding CLI by attachment connectionId.
        const respondingAttachment = respondingWs.deserializeAttachment() as WSAttachment | null;
        if (
          respondingAttachment?.role !== 'cli' ||
          respondingAttachment.connectionId !== durable.targetConnectionId
        ) {
          this.completedCorrelationIds.delete(id);
          ownsReservation = false;
          return;
        }

        // Resolve the originating web socket by persisted webConnectionId.
        const webWs = this.findWebByConnectionId(durable.webConnectionId);
        if (!webWs) {
          // D8 case 2: web socket is gone. Shape the terminal outcome
          // (catalog guard, error normalization) before persisting done
          // so a mutationId retry receives the same shaped outcome as
          // live delivery.
          const shaped = this.shapeCommandError(durable.command, result, error);
          let shapedResult = this.boundDurableResult(shaped.result);
          let shapedError = shaped.error;
          // When the durable result is truncated, a mutationId retry must
          // receive an error — not a false-success truncated marker.
          if (this.isTruncatedResult(shapedResult)) {
            shapedResult = undefined;
            shapedError = shapedError ?? DURABLE_RESULT_TOO_LARGE_ERROR;
          }
          await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, {
            ...durable,
            state: 'done',
            ...(shapedResult !== undefined ? { result: shapedResult } : {}),
            ...(shapedError !== undefined ? { error: shapedError } : {}),
          });
          // Reservation held through the terminal write; clear after success.
          this.completedCorrelationIds.delete(id);
          ownsReservation = false;
          return;
        }

        // Build an in-memory entry so the rest of handleCliResponse works.
        entry = {
          ws: webWs,
          sessionId: durable.sessionId,
          originalId: durable.originalId,
          command: durable.command,
          expectedOwnerConnectionId: durable.expectedOwnerConnectionId,
          targetConnectionId: durable.targetConnectionId,
          expiresAt: durable.expiresAt,
          targetCliWs: respondingWs,
        };
        rehydrated = true;
        // Reservation held through the rest of handleCliResponse — cleared
        // after terminal storage.put succeeds (catalog guard and normal
        // path) or on any throw.
      } catch (error: unknown) {
        // Clean reservation on unexpected error during rehydration.
        this.completedCorrelationIds.delete(id);
        ownsReservation = false;
        throw error;
      }
    } else if (entry.targetCliWs !== respondingWs) {
      // Strict socket-identity check for an entry still in memory.
      return;
    }

    // All code after acquisition is protected: catalog serialization,
    // boundDurableResult, attachment reads, and storage.put are inside
    // this try block. The finally clears any reservation that survives
    // a throw.
    try {
      // Validate catalog result size for rehydrated entries too.
      if (CATALOG_DEDUPE_COMMANDS.has(entry.command) && result !== undefined) {
        const serializedResult = JSON.stringify(result);
        const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
        if (resultBytes > MAX_CATALOG_RESULT_BYTES) {
          // For non-rehydrated entries, reserve the correlationId before the
          // durable write so a concurrent CLI reply is fenced.
          if (!rehydrated) {
            // Guard: do not override an already-expired terminal outcome.
            const now = Date.now();
            if (entry.expiresAt <= now) {
              this.pendingCommands.delete(id);
              return;
            }
            this.pendingCommands.delete(id);
            // Reserve the correlationId synchronously so a concurrent CLI
            // reply cannot re-process the same command during the durable
            // write window.
            this.completedCorrelationIds.add(id);
            ownsReservation = true;
          }

          // Persist the terminal outcome durably BEFORE sending any live
          // response.  If storage fails, no live send occurs and reservations
          // are cleaned — the error propagates to waitUntil.
          let catWebConnectionId: string;
          if (rehydrated) {
            // Use the durable entry captured at the top of handleCliResponse.
            // A second getDurablePendingCommand can miss (race), which would
            // abandon terminal processing.
            catWebConnectionId = rehydratedDurable?.webConnectionId ?? 'unknown';
          } else {
            catWebConnectionId =
              (entry.ws.deserializeAttachment() as WSAttachment | null)?.role === 'web'
                ? (
                    entry.ws.deserializeAttachment() as WSAttachment & {
                      role: 'web';
                    }
                  ).connectionId
                : 'unknown';
          }
          try {
            await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, {
              sessionId: entry.sessionId,
              originalId: entry.originalId,
              command: entry.command,
              expectedOwnerConnectionId: entry.expectedOwnerConnectionId,
              targetConnectionId: entry.targetConnectionId,
              expiresAt: entry.expiresAt,
              webConnectionId: catWebConnectionId,
              state: 'done',
              error: CATALOG_TOO_LARGE_ERROR,
            } satisfies PendingCommandEntry);
          } catch (_error: unknown) {
            this.completedCorrelationIds.delete(id);
            ownsReservation = false;
            // Re-throw to the surrounding waitUntil catch so the task
            // failure is logged and never left unhandled.
            throw _error;
          }

          // Durable write succeeded — clear the marker.  The durable 'done'
          // state now guards against duplicate delivery.
          this.completedCorrelationIds.delete(id);
          ownsReservation = false;

          // Send the live response now that the durable entry is stored.
          if (!rehydrated) {
            this.sendToWeb(entry.ws, {
              type: 'response',
              id: entry.originalId,
              error: CATALOG_TOO_LARGE_ERROR,
            });
          } else {
            const targetWeb = this.findWebByConnectionId(catWebConnectionId);
            if (targetWeb) {
              this.sendToWeb(targetWeb, {
                type: 'response',
                id: entry.originalId,
                error: CATALOG_TOO_LARGE_ERROR,
              });
            }
          }
          return;
        }
      }

      let structuredError: {
        source: string;
        code: string;
        message: string;
      } | null = null;
      let stringError: string | null = null;
      let sanitizeAsFailed = false;

      if (typeof error === 'string' && CLI_UPGRADE_REQUIRED_COMMANDS.has(entry.command)) {
        if (error === `unknown command: ${entry.command}`) {
          structuredError =
            entry.command === 'create_session'
              ? CLI_UPGRADE_REQUIRED_CREATE_SESSION_ERROR
              : CLI_UPGRADE_REQUIRED_SLASH_ERROR;
        } else {
          stringError = error;
        }
      } else if (typeof error === 'string') {
        stringError = error;
      } else if (error !== undefined) {
        sanitizeAsFailed = true;
      }

      const terminalError =
        structuredError ?? stringError ?? (sanitizeAsFailed ? CLI_COMMAND_ERROR : undefined);

      // Write the terminal outcome durably BEFORE any live response.
      // If storage.put fails, the error propagates to the waitUntil boundary
      // — reservation markers are cleaned and no live send has occurred.
      //
      // Guard: a live entry that has already expired must not override the
      // terminal outcome set by expirePendingCommands. Drop silently.
      if (!rehydrated) {
        const now = Date.now();
        if (entry.expiresAt <= now) {
          this.pendingCommands.delete(id);
          return;
        }
        this.pendingCommands.delete(id);
        // Reserve the correlationId synchronously so a concurrent CLI
        // reply cannot re-process the same command during the durable
        // write window.
        this.completedCorrelationIds.add(id);
        ownsReservation = true;
      }

      // boundDurableResult, attachment reads, and storage.put are inside this
      // try block so any throw (e.g. JSON.stringify on oversized results)
      // is caught by the outer finally, which clears the reservation.
      let durableResult: unknown;
      let webConnectionId: string;
      try {
        durableResult = this.boundDurableResult(result);
        // When the durable result is truncated, a mutationId retry must
        // receive an error — not a false-success truncated marker. The live
        // response still carries the original full result via the `result`
        // variable (not `durableResult`).
        let durableError = terminalError;
        if (this.isTruncatedResult(durableResult)) {
          durableResult = undefined;
          durableError = durableError ?? DURABLE_RESULT_TOO_LARGE_ERROR;
        }
        webConnectionId = rehydrated
          ? (rehydratedDurable?.webConnectionId ?? 'unknown')
          : (entry.ws.deserializeAttachment() as WSAttachment | null)?.role === 'web'
            ? (entry.ws.deserializeAttachment() as WSAttachment & { role: 'web' }).connectionId
            : 'unknown';

        await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, {
          sessionId: entry.sessionId,
          originalId: entry.originalId,
          command: entry.command,
          expectedOwnerConnectionId: entry.expectedOwnerConnectionId,
          targetConnectionId: entry.targetConnectionId,
          expiresAt: entry.expiresAt,
          webConnectionId: webConnectionId ?? 'unknown',
          state: 'done',
          ...(durableResult !== undefined ? { result: durableResult } : {}),
          ...(durableError !== undefined ? { error: durableError } : {}),
        } satisfies PendingCommandEntry);
      } catch (_error: unknown) {
        // Clean the synchronous reservation on storage failure — the error
        // propagates to waitUntil; no live send has occurred.
        this.completedCorrelationIds.delete(id);
        ownsReservation = false;
        // Re-throw to the surrounding waitUntil catch so the task
        // failure is logged and never left unhandled.
        throw _error;
      }

      // Durable write succeeded. Clear the in-memory marker on both paths:
      // the durable 'done' state replaces it as the dedupe guard.
      this.completedCorrelationIds.delete(id);
      ownsReservation = false;

      if (!rehydrated) {
        // Send the live response now that the durable entry is safely stored.
        this.sendToWeb(entry.ws, {
          type: 'response',
          id: entry.originalId,
          ...(result !== undefined ? { result } : {}),
          ...(structuredError !== null
            ? { error: structuredError }
            : stringError !== null
              ? { error: stringError }
              : sanitizeAsFailed
                ? { error: CLI_COMMAND_ERROR }
                : {}),
        });
      } else {
        // Rehydrated entry: re-resolve the web socket by the persisted id
        // and send the response now.
        const targetWebWs = this.findWebByConnectionId(webConnectionId ?? 'unknown');
        if (targetWebWs) {
          this.sendToWeb(targetWebWs, {
            type: 'response',
            id: entry.originalId,
            ...(result !== undefined ? { result } : {}),
            ...(structuredError !== null
              ? { error: structuredError }
              : stringError !== null
                ? { error: stringError }
                : sanitizeAsFailed
                  ? { error: CLI_COMMAND_ERROR }
                  : {}),
          });
        }
      }
    } finally {
      if (ownsReservation) {
        this.completedCorrelationIds.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Web message handling
  // ---------------------------------------------------------------------------

  private async handleWebMessage(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    parsed: unknown
  ): Promise<void> {
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
        await this.handleWebSubscribe(ws, attachment, msg.sessionId);
        break;
      case 'unsubscribe':
        this.handleWebUnsubscribe(ws, attachment, msg.sessionId);
        break;
      case 'command':
        await this.handleWebCommand(ws, attachment, msg);
        break;
      case 'ping':
        this.sendToWeb(ws, { type: 'pong', nonce: msg.nonce });
        break;
    }
  }

  private async handleWebSubscribe(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    sessionId: string
  ): Promise<void> {
    // Recheck current membership before subscribing: a removed member must not
    // receive events from an org session they no longer have access to.
    const kiloUserId = attachment.kiloUserId;
    if (!kiloUserId) {
      return;
    }
    const accessible = await resolveAccessibleKiloSession(this.env, {
      kiloUserId,
      kiloSessionId: sessionId,
    });
    if (!accessible) {
      return;
    }

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

  private async handleWebCommand(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'web' },
    msg: {
      id: string;
      command: string;
      sessionId?: string;
      connectionId?: string;
      data?: unknown;
      mutationId?: string;
    }
  ): Promise<void> {
    const now = Date.now();
    this.expirePendingCommands(now);

    // Reject anything outside the viewer command allowlist before we touch
    // ownership, allocate a pending slot, or forward to the CLI.
    if (!ALLOWED_VIEWER_COMMANDS.has(msg.command)) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: COMMAND_NOT_ALLOWED_ERROR,
      });
      return;
    }

    if (
      msg.command === 'exit_cli' &&
      (!msg.sessionId ||
        typeof msg.data !== 'object' ||
        msg.data === null ||
        Array.isArray(msg.data) ||
        Object.keys(msg.data).length !== 1 ||
        !Object.hasOwn(msg.data, 'protocolVersion') ||
        Reflect.get(msg.data, 'protocolVersion') !== 1)
    ) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: INVALID_COMMAND_ERROR,
      });
      return;
    }

    // Command-time access recheck: a removed member must not forward a command
    // to a session they no longer have access to. Catalog commands without a
    // sessionId skip this check.
    if (msg.sessionId) {
      const kiloUserId = attachment.kiloUserId;
      if (!kiloUserId) {
        this.sendToWeb(ws, {
          type: 'response',
          id: msg.id,
          error: SESSION_ACCESS_DENIED_ERROR,
        });
        return;
      }
      const accessible = await resolveAccessibleKiloSession(this.env, {
        kiloUserId,
        kiloSessionId: msg.sessionId,
      });
      if (!accessible) {
        this.sendToWeb(ws, {
          type: 'response',
          id: msg.id,
          error: SESSION_ACCESS_DENIED_ERROR,
        });
        return;
      }
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
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: 'Session owner not found',
      });
      return;
    }

    const targetAttachment = targetCli.deserializeAttachment() as WSAttachment | null;
    if (targetAttachment?.role !== 'cli') return;
    const expectedOwnerConnectionId =
      msg.sessionId && msg.connectionId ? msg.connectionId : undefined;
    const targetConnectionId = targetAttachment.connectionId;

    // Resolve the originating web socket's connectionId from its attachment.
    const webAttachment = ws.deserializeAttachment() as WSAttachment | null;
    const webConnectionId =
      webAttachment?.role === 'web' && webAttachment.connectionId
        ? webAttachment.connectionId
        : 'unknown';

    // In-memory dedupe for catalog commands from the same web socket
    if (
      !msg.mutationId &&
      CATALOG_DEDUPE_COMMANDS.has(msg.command) &&
      [...this.pendingCommands.values()].some(
        entry =>
          entry.ws === ws &&
          entry.command === msg.command &&
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

    // D8 mutationId dedupe: synchronous reservation prevents concurrent
    // same-ID dispatch across the async storage read below.
    if (msg.mutationId) {
      const mutationId = msg.mutationId;
      // Reject oversized mutation IDs before they become unsafe storage keys.
      if (mutationId.length > MAX_MUTATION_ID_LENGTH) {
        this.sendToWeb(ws, {
          type: 'response',
          id: msg.id,
          error: MUTATION_ID_TOO_LONG_ERROR,
        });
        return;
      }
      // Atomic reservation: check and set synchronously before any await.
      if (this.inflightMutations.has(mutationId)) {
        if (CATALOG_DEDUPE_COMMANDS.has(msg.command)) {
          this.sendToWeb(ws, {
            type: 'response',
            id: msg.id,
            error: CATALOG_REQUEST_PENDING_ERROR,
          });
        } else {
          this.sendToWeb(ws, {
            type: 'response',
            id: msg.id,
            error: {
              source: 'relay',
              code: 'COMMAND_ALREADY_PENDING',
              message: 'Command is already in flight',
            },
          });
        }
        return;
      }
      this.inflightMutations.add(mutationId);

      const capturedTargetCli = targetCli;
      this.ctx.waitUntil(
        (async () => {
          try {
            const durable = await this.getDurablePendingCommand(mutationId);
            if (!durable) {
              // No existing entry: check cap (counts both in-memory and durable entries).
              const durableCount = await this.countDurablePendingCommands();
              const total = this.pendingCommands.size + durableCount;
              if (total >= UserConnectionDO.MAX_PENDING_COMMANDS) {
                this.sendToWeb(ws, {
                  type: 'response',
                  id: msg.id,
                  error: PENDING_COMMAND_LIMIT_ERROR,
                });
                return;
              }
              await this.dispatchDurableWebCommand(
                ws,
                msg,
                capturedTargetCli,
                targetConnectionId,
                expectedOwnerConnectionId,
                webConnectionId,
                now
              );
              return;
            }

            if (durable.state === 'done') {
              await this.updateDurablePendingCommandOriginalId(mutationId, msg.id);
              this.sendToWeb(ws, {
                type: 'response',
                id: msg.id,
                ...(durable.result !== undefined ? { result: durable.result } : {}),
                ...(durable.error !== undefined ? { error: durable.error } : {}),
              });
              return;
            }

            // Entry is 'pending': dedupe.
            if (CATALOG_DEDUPE_COMMANDS.has(msg.command)) {
              this.sendToWeb(ws, {
                type: 'response',
                id: msg.id,
                error: CATALOG_REQUEST_PENDING_ERROR,
              });
            } else {
              this.sendToWeb(ws, {
                type: 'response',
                id: msg.id,
                error: {
                  source: 'relay',
                  code: 'COMMAND_ALREADY_PENDING',
                  message: 'Command is already in flight',
                },
              });
            }
          } finally {
            this.inflightMutations.delete(mutationId);
          }
        })()
      );
      return;
    }

    // In-memory cap check for the common path.
    if (this.pendingCommands.size >= UserConnectionDO.MAX_PENDING_COMMANDS) {
      this.sendToWeb(ws, {
        type: 'response',
        id: msg.id,
        error: PENDING_COMMAND_LIMIT_ERROR,
      });
      return;
    }

    this.dispatchWebCommandSync(
      ws,
      msg,
      targetCli,
      targetConnectionId,
      expectedOwnerConnectionId,
      webConnectionId,
      now
    );
  }

  /**
   * Common dispatch: persist the durable entry before forwarding the command.
   */
  private async dispatchDurableWebCommand(
    ws: WebSocket,
    msg: {
      id: string;
      command: string;
      sessionId?: string;
      connectionId?: string;
      data?: unknown;
      mutationId?: string;
    },
    targetCli: WebSocket,
    targetConnectionId: string,
    expectedOwnerConnectionId: string | undefined,
    webConnectionId: string,
    now: number
  ): Promise<void> {
    const correlationId = msg.mutationId ?? crypto.randomUUID();
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
    await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${correlationId}`, {
      sessionId: msg.sessionId,
      originalId: msg.id,
      command: msg.command,
      expectedOwnerConnectionId,
      targetConnectionId,
      expiresAt: now + UserConnectionDO.PENDING_COMMAND_TTL_MS,
      webConnectionId,
      state: 'pending' as const,
    } satisfies PendingCommandEntry);
    this.scheduleNextAlarm(now);
    this.scheduleDurablePendingAlarm();

    this.sendToCli(targetCli, {
      type: 'command',
      id: correlationId,
      command: msg.command,
      data: msg.data,
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      ...(msg.mutationId ? { mutationId: msg.mutationId } : {}),
    });
  }

  private dispatchWebCommandSync(
    ws: WebSocket,
    msg: {
      id: string;
      command: string;
      sessionId?: string;
      connectionId?: string;
      data?: unknown;
      mutationId?: string;
    },
    targetCli: WebSocket,
    targetConnectionId: string,
    expectedOwnerConnectionId: string | undefined,
    webConnectionId: string,
    now: number
  ): void {
    const correlationId = crypto.randomUUID();
    const pendingCommandKey = `${PENDING_COMMAND_KEY_PREFIX}${correlationId}`;
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
    this.pendingInitialCommandWrites.add(correlationId);
    this.ctx.waitUntil(
      this.ctx.storage
        .put(pendingCommandKey, {
          sessionId: msg.sessionId,
          originalId: msg.id,
          command: msg.command,
          expectedOwnerConnectionId,
          targetConnectionId,
          expiresAt: now + UserConnectionDO.PENDING_COMMAND_TTL_MS,
          webConnectionId,
          state: 'pending' as const,
        } satisfies PendingCommandEntry)
        .then(async () => {
          const terminalEntry = this.terminalDuringInitialWrite.get(correlationId);
          if (terminalEntry) {
            await this.ctx.storage.put(pendingCommandKey, terminalEntry);
            this.completedCorrelationIds.delete(correlationId);
            this.terminalDuringInitialWrite.delete(correlationId);
            return;
          }
          this.scheduleNextAlarm(now);
          this.scheduleDurablePendingAlarm();
          this.sendToCli(targetCli, {
            type: 'command',
            id: correlationId,
            command: msg.command,
            data: msg.data,
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
          });
        })
        .catch((error: unknown) => {
          // The initial durable write failed: the command was never forwarded to
          // the CLI. Clean any terminal stash and its reservation marker so they
          // do not leak until DO eviction.
          this.terminalDuringInitialWrite.delete(correlationId);
          this.completedCorrelationIds.delete(correlationId);
          console.error('Failed to persist durable pending command before forwarding', {
            correlationId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.pendingInitialCommandWrites.delete(correlationId);
          if (!this.terminalDuringInitialWrite.has(correlationId)) {
            // Only clear the reservation marker when the entry is still tracked
            // in-memory. If expirePendingCommands already removed it and set
            // the marker, the async sweep owns cleanup and we must not clear it
            // here (otherwise a concurrent finishDurablePendingCommands could
            // double-deliver).
            if (this.pendingCommands.has(correlationId)) {
              this.completedCorrelationIds.delete(correlationId);
            }
          }
        })
    );
  }

  // ---------------------------------------------------------------------------
  // Disconnect handling
  // ---------------------------------------------------------------------------

  private async handleCliDisconnect(
    disconnectedWs: WebSocket,
    attachment: WSAttachment & { role: 'cli' }
  ): Promise<void> {
    const { connectionId } = attachment;

    // If another CLI socket already has this connectionId, this is a stale
    // close from a reconnect — the replacement socket is already active.
    // Exclude the closing socket: under wrangler/workerd, getWebSockets() still
    // includes it during webSocketClose, so matching self would always look "replaced"
    // and skip ownership cleanup + attention reset (DEF-5 E2E failure).
    const replaced = this.ctx.getWebSockets('cli').some(ws => {
      if (ws === disconnectedWs) return false;
      const att = ws.deserializeAttachment() as WSAttachment | null;
      return att?.role === 'cli' && att.connectionId === connectionId;
    });

    // Fail pending commands that targeted this specific socket.
    // Await so the durable terminal entries are persisted before we proceed
    // to broadcast cli.disconnected. Failed first writes retry in waitUntil.
    await this.failPendingCommandsForSocket(disconnectedWs, !replaced);

    if (replaced) {
      console.log('Stale CLI socket closed (already replaced)', {
        connectionId,
      });
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
    this.connectionCapabilities.delete(connectionId);
    this.lastHeartbeatAt.delete(connectionId);

    console.log('CLI socket disconnected', {
      connectionId,
      droppedSessions: ownedSessions.size,
      remainingCliSockets: this.ctx.getWebSockets('cli').length,
    });

    // Leave webSubscriptions intact — a reconnecting CLI can resume

    // Reset stored attention before broadcasting disconnect so the mobile
    // departure refetch observes `retry` rather than a stuck `question`.
    // kiloUserId comes from the CLI attachment (authenticated /user/cli route);
    // without it we cannot safely target rows and must no-op.
    await this.resetOwnedSessionAttentionOnDisconnect(attachment.kiloUserId, ownedSessions);

    this.broadcastToWeb({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId },
    });
  }

  /**
   * Commit attention clears for owned sessions before `cli.disconnected`.
   * Identity: attachment `kiloUserId` only — never guess from DO name.
   */
  private async resetOwnedSessionAttentionOnDisconnect(
    kiloUserId: string | undefined,
    ownedSessions: ReadonlySet<string>
  ): Promise<void> {
    if (ownedSessions.size === 0) return;

    if (!kiloUserId) {
      console.warn(
        'Skipping attention status reset on CLI disconnect: missing kiloUserId on attachment',
        { ownedSessionCount: ownedSessions.size }
      );
      return;
    }

    const results = await Promise.allSettled(
      [...ownedSessions].map(async sessionId => {
        const stub = getSessionIngestDO(this.env, { kiloUserId, sessionId });
        await stub.resetAttentionStatusOnCliDisconnect(kiloUserId, sessionId);
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to reset attention status on CLI disconnect', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
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

    // Clean up any pending commands from this web socket.
    // Step 26b: keep the durable entry — the CLI may still reply, and a
    // mutationId retry needs the stored outcome. Only the in-memory entry is
    // dropped; the durable entry lives until its TTL or a terminal outcome.
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
    HeartbeatSession & {
      connectionId: string;
      protocolVersion?: string;
      capabilities?: ConnectionCapabilities;
    }
  > {
    this.ensureState();
    return this.aggregateSessions();
  }

  /**
   * Live-socket scan of currently connected CLI WebSockets. Each socket whose
   * attachment carries an `instance` (i.e. it is a `kilo remote` spawner)
   * contributes one row; legacy CLIs that predate the spawner never report
   * `instance` and are excluded by design.
   *
   * No in-memory map is consulted: hibernation/restart can never produce a
   * stale row because we only read from sockets that are alive right now.
   * The 2KB `serializeAttachment` budget comfortably accommodates a bounded
   * instance object (well under 200 bytes).
   */
  getConnectedInstances(): { instances: ConnectedInstanceRow[] } {
    this.ensureState();
    const instances: ConnectedInstanceRow[] = [];
    for (const ws of this.ctx.getWebSockets('cli')) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.role !== 'cli' || !att.instance) continue;
      instances.push({
        connectionId: att.connectionId,
        name: att.instance.name,
        projectName: att.instance.projectName,
        ...(att.instance.version ? { version: att.instance.version } : {}),
        ...(att.capabilities ? { capabilities: att.capabilities } : {}),
      });
    }
    return { instances };
  }

  /**
   * Close every live web viewer socket. Called on member removal so a removed
   * member's open viewer connections are torn down immediately. Returns the
   * number of sockets closed.
   */
  closeViewerSockets(): number {
    const sockets = this.ctx.getWebSockets('web');
    for (const ws of sockets) {
      ws.close(1000, 'session access revoked');
    }
    return sockets.length;
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

  /**
   * Persist a web→CLI rename under KV (offline catch-up) and deliver
   * `session.renamed` to the owning CLI socket when one is connected.
   */
  async notifySessionRenamed(sessionId: string, title: string): Promise<{ delivered: boolean }> {
    this.ensureState();
    await this.ctx.storage.put(`${RENAME_KEY_PREFIX}${sessionId}`, {
      title,
      at: Date.now(),
    } satisfies RenameEntry);

    const ownerConnectionId = this.sessionOwners.get(sessionId);
    if (!ownerConnectionId) {
      return { delivered: false };
    }
    const cliWs = this.findCliByConnectionId(ownerConnectionId);
    if (!cliWs) {
      return { delivered: false };
    }

    this.sendToCli(cliWs, {
      type: 'system',
      event: 'session.renamed',
      data: { sessionId, title },
    });
    return { delivered: true };
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
        this.ctx.waitUntil(
          this.failPendingCommandsForSocket(ws, false).catch((error: unknown) => {
            console.error('Failed to persist terminal commands for stale socket', {
              connectionId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        );
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

  private findWebByConnectionId(connectionId: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets('web')) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (
        attachment?.role === 'web' &&
        attachment.connectionId === connectionId &&
        !attachment.replaced
      ) {
        return ws;
      }
    }
    return undefined;
  }

  private async failPendingCommandsForSocket(targetWs: WebSocket, cliGone: boolean): Promise<void> {
    // Collect correlationIds handled in the in-memory sweep so the durable
    // sweep in finishDurablePendingCommands does not double-deliver.
    const handledIds = new Set<string>();
    const entries = [...this.pendingCommands].filter(([, entry]) => entry.targetCliWs === targetWs);
    for (const [id] of entries) {
      handledIds.add(id);
      this.pendingCommands.delete(id);
      this.completedCorrelationIds.add(id);
    }
    for (const [id, entry] of entries) {
      // The owning CLI is really gone, so a forwarded `exit_cli` got what it
      // asked for: this session is no longer owned by anyone.
      const exited = cliGone && entry.command === 'exit_cli';
      const isOwnerFenced = !exited && Boolean(entry.expectedOwnerConnectionId);
      // Live wire error: bare string for CLI-disconnect compatibility
      // (the client's parseCommandError expects a string, not structured).
      const liveError = exited
        ? undefined
        : isOwnerFenced
          ? SESSION_OWNER_CHANGED_ERROR
          : 'CLI disconnected';
      const durableError = liveError;

      // Step 26: pair the in-memory delete with a durable done transition.
      // Persist the terminal outcome BEFORE sending the live response.
      // If storage.put fails, no live send occurs. A waitUntil retry keeps
      // the terminal outcome fenced while the loop continues.
      const webAtt = entry.ws.deserializeAttachment() as WSAttachment | null;
      const durableEntry: PendingCommandEntry = {
        sessionId: entry.sessionId,
        originalId: entry.originalId,
        command: entry.command,
        expectedOwnerConnectionId: entry.expectedOwnerConnectionId,
        targetConnectionId: entry.targetConnectionId,
        expiresAt: entry.expiresAt,
        webConnectionId: webAtt?.role === 'web' ? webAtt.connectionId : 'unknown',
        state: 'done',
        ...(exited ? { result: {} } : { error: durableError }),
      };
      const initialWritePending = this.pendingInitialCommandWrites.has(id);
      if (initialWritePending) {
        this.terminalDuringInitialWrite.set(id, durableEntry);
      }
      try {
        await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, durableEntry);
      } catch (error) {
        this.ctx.waitUntil(
          this.ctx.storage
            .put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, durableEntry)
            .then(() => {
              if (!initialWritePending) {
                this.completedCorrelationIds.delete(id);
              }
              const webWs = this.findWebByConnectionId(durableEntry.webConnectionId);
              if (webWs) {
                this.sendToWeb(
                  webWs,
                  exited
                    ? { type: 'response', id: durableEntry.originalId, result: {} }
                    : {
                        type: 'response',
                        id: durableEntry.originalId,
                        error: durableError,
                      }
                );
              }
            })
            .catch(retryError => {
              console.error('Failed to retry durable CLI-disconnect terminal outcome', {
                correlationId: id,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            })
        );
        console.error('Failed to persist durable CLI-disconnect terminal outcome', {
          correlationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!initialWritePending) {
        this.completedCorrelationIds.delete(id);
      }
      this.sendToWeb(
        entry.ws,
        exited
          ? { type: 'response', id: entry.originalId, result: {} }
          : {
              type: 'response',
              id: entry.originalId,
              error: liveError,
            }
      );
    }

    const attachment = targetWs.deserializeAttachment() as WSAttachment | null;
    if (cliGone && attachment?.role === 'cli') {
      this.ctx.waitUntil(
        this.finishDurablePendingCommands(
          entry => entry.targetConnectionId === attachment.connectionId,
          'CLI disconnected',
          handledIds
        )
      );
    }
  }

  private async failPendingCommandsForOwnerChange(
    sessionId: string,
    nextOwnerConnectionId: string | undefined
  ): Promise<void> {
    const handledIds = new Set<string>();
    const entries = [...this.pendingCommands].filter(
      ([, entry]) =>
        entry.sessionId === sessionId && entry.targetConnectionId !== nextOwnerConnectionId
    );
    for (const [id] of entries) {
      handledIds.add(id);
      this.pendingCommands.delete(id);
      this.completedCorrelationIds.add(id);
    }
    for (const [id, entry] of entries) {
      // `exit_cli` asked for exactly this: the session is no longer owned.
      // Ownership moving to another CLI is a genuine owner change and still fails.
      const exited = entry.command === 'exit_cli' && nextOwnerConnectionId === undefined;

      // Step 26: pair the in-memory delete with a durable done transition.
      // Persist the terminal outcome BEFORE sending the live response.
      // If storage.put fails, no live send occurs. A waitUntil retry keeps
      // the terminal outcome fenced while the loop continues.
      const webAtt = entry.ws.deserializeAttachment() as WSAttachment | null;
      const durableEntry: PendingCommandEntry = {
        sessionId: entry.sessionId,
        originalId: entry.originalId,
        command: entry.command,
        expectedOwnerConnectionId: entry.expectedOwnerConnectionId,
        targetConnectionId: entry.targetConnectionId,
        expiresAt: entry.expiresAt,
        webConnectionId: webAtt?.role === 'web' ? webAtt.connectionId : 'unknown',
        state: 'done',
        ...(exited ? { result: {} } : { error: SESSION_OWNER_CHANGED_ERROR }),
      };
      const initialWritePending = this.pendingInitialCommandWrites.has(id);
      if (initialWritePending) {
        this.terminalDuringInitialWrite.set(id, durableEntry);
      }
      try {
        await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, durableEntry);
      } catch (error) {
        this.ctx.waitUntil(
          this.ctx.storage
            .put(`${PENDING_COMMAND_KEY_PREFIX}${id}`, durableEntry)
            .then(() => {
              if (!initialWritePending) {
                this.completedCorrelationIds.delete(id);
              }
              const webWs = this.findWebByConnectionId(durableEntry.webConnectionId);
              if (webWs) {
                this.sendToWeb(
                  webWs,
                  exited
                    ? { type: 'response', id: durableEntry.originalId, result: {} }
                    : {
                        type: 'response',
                        id: durableEntry.originalId,
                        error: SESSION_OWNER_CHANGED_ERROR,
                      }
                );
              }
            })
            .catch(retryError => {
              console.error('Failed to retry durable owner-change terminal outcome', {
                correlationId: id,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            })
        );
        console.error('Failed to persist durable owner-change terminal outcome', {
          correlationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!initialWritePending) {
        this.completedCorrelationIds.delete(id);
      }
      this.sendToWeb(
        entry.ws,
        exited
          ? { type: 'response', id: entry.originalId, result: {} }
          : {
              type: 'response',
              id: entry.originalId,
              error: SESSION_OWNER_CHANGED_ERROR,
            }
      );
    }

    this.ctx.waitUntil(
      this.finishDurablePendingCommands(
        entry =>
          entry.sessionId === sessionId && entry.targetConnectionId !== nextOwnerConnectionId,
        SESSION_OWNER_CHANGED_ERROR,
        handledIds
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Command error shaping
  // ---------------------------------------------------------------------------

  /**
   * Compute the shaped terminal outcome for a command reply.
   * Applies catalog size guard and error normalization (CLI_UPGRADE_REQUIRED
   * mapping, CLI_COMMAND_ERROR sanitization). Pure computation — no side effects.
   */
  private shapeCommandError(
    command: string,
    result: unknown,
    error: unknown
  ): { result?: unknown; error?: unknown } {
    // Catalog size guard: oversized results must not persist their raw payload.
    if (CATALOG_DEDUPE_COMMANDS.has(command) && result !== undefined) {
      const serializedResult = JSON.stringify(result);
      const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
      if (resultBytes > MAX_CATALOG_RESULT_BYTES) {
        return { error: CATALOG_TOO_LARGE_ERROR };
      }
    }

    let structuredError: {
      source: string;
      code: string;
      message: string;
    } | null = null;
    let stringError: string | null = null;
    let sanitizeAsFailed = false;

    if (typeof error === 'string' && CLI_UPGRADE_REQUIRED_COMMANDS.has(command)) {
      if (error === `unknown command: ${command}`) {
        structuredError =
          command === 'create_session'
            ? CLI_UPGRADE_REQUIRED_CREATE_SESSION_ERROR
            : CLI_UPGRADE_REQUIRED_SLASH_ERROR;
      } else {
        stringError = error;
      }
    } else if (typeof error === 'string') {
      stringError = error;
    } else if (error !== undefined) {
      sanitizeAsFailed = true;
    }

    const terminalError =
      structuredError ?? stringError ?? (sanitizeAsFailed ? CLI_COMMAND_ERROR : undefined);

    return {
      ...(result !== undefined ? { result } : {}),
      ...(terminalError !== undefined ? { error: terminalError } : {}),
    };
  }

  /**
   * Bound a terminal result so the durable storage.put never exceeds the
   * Cloudflare DO value limit. Returns the original result when under the
   * threshold, or a size-exceeded marker otherwise.
   */
  private boundDurableResult(result: unknown): unknown {
    if (result === undefined) return undefined;
    const serialized = JSON.stringify(result);
    const byteCount = new TextEncoder().encode(serialized).byteLength;
    if (byteCount <= MAX_DURABLE_RESULT_BYTES) return result;
    return { _truncated: true, bytes: byteCount };
  }

  /**
   * Detect the truncated marker returned by boundDurableResult.
   * Callers must use this to route a durable-sized result to an error
   * field so a mutationId retry does not return a false success.
   */
  private isTruncatedResult(value: unknown): boolean {
    return (
      value !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      '_truncated' in value &&
      (value as Record<string, unknown>)._truncated === true
    );
  }

  // ---------------------------------------------------------------------------
  // Durable pending command storage (D8)
  // ---------------------------------------------------------------------------

  private async getDurablePendingCommand(
    correlationId: string
  ): Promise<PendingCommandEntry | undefined> {
    return this.ctx.storage.get<PendingCommandEntry>(
      `${PENDING_COMMAND_KEY_PREFIX}${correlationId}`
    );
  }

  private async countDurablePendingCommands(): Promise<number> {
    const entries = await this.ctx.storage.list({
      prefix: PENDING_COMMAND_KEY_PREFIX,
    });
    return entries.size;
  }

  private async updateDurablePendingCommandOriginalId(
    correlationId: string,
    newOriginalId: string
  ): Promise<void> {
    const entry = await this.getDurablePendingCommand(correlationId);
    if (!entry) return;
    entry.originalId = newOriginalId;
    await this.ctx.storage.put(`${PENDING_COMMAND_KEY_PREFIX}${correlationId}`, entry);
  }

  private async finishDurablePendingCommands(
    matches: (entry: PendingCommandEntry) => boolean,
    error: unknown,
    skipIds?: ReadonlySet<string>
  ): Promise<void> {
    const entries = await this.ctx.storage.list<PendingCommandEntry>({
      prefix: PENDING_COMMAND_KEY_PREFIX,
    });
    await Promise.all(
      [...entries].flatMap(([key, entry]) => {
        if (entry.state !== 'pending' || !matches(entry)) return [];
        const correlationId = key.slice(PENDING_COMMAND_KEY_PREFIX.length);
        // Skip entries already delivered live by the in-memory sweep.
        // Prevents a duplicate delivery when the in-memory storage.put and
        // finishDurablePendingCommands race within separate waitUntil tasks.
        if (skipIds?.has(correlationId)) return [];
        // Claim the correlation BEFORE the durable put so a concurrent
        // sweep with a stale list snapshot cannot pass through its
        // awaited put and send after we already delivered.
        if (this.completedCorrelationIds.has(correlationId)) return [];
        this.completedCorrelationIds.add(correlationId);
        // After the durable write succeeds, deliver to a reattached web
        // socket (D8 case 3). The in-memory sweep already delivered to the
        // original socket; this path covers a socket that reconnected after
        // the original disconnected (different webConnectionId path).
        const webWs = this.findWebByConnectionId(entry.webConnectionId);
        const putPromise = this.ctx.storage
          .put(key, {
            ...entry,
            state: 'done' as const,
            error,
          })
          .then(() => {
            if (webWs) {
              this.sendToWeb(webWs, {
                type: 'response',
                id: entry.originalId,
                error,
              });
            }
          })
          .catch((_error: unknown) => {
            // On storage failure: release the claim so a retry or another
            // concurrent path can deliver.  Log but do not rethrow —
            // Promise.all already rejects on unhandled rejections; the
            // caller's waitUntil catch logs upstream.
            this.completedCorrelationIds.delete(correlationId);
            console.error('Failed to persist finishDurablePendingCommands terminal outcome', {
              correlationId,
              error: _error instanceof Error ? _error.message : String(_error),
            });
          });
        return [putPromise];
      })
    );
  }

  private scheduleDurablePendingAlarm(): void {
    this.ctx.waitUntil(
      (async () => {
        const entries = await this.ctx.storage.list<PendingCommandEntry>({
          prefix: PENDING_COMMAND_KEY_PREFIX,
        });
        const now = Date.now();
        let expiresAt: number | undefined;
        for (const entry of entries.values()) {
          if (entry.expiresAt <= now) continue;
          if (expiresAt === undefined || entry.expiresAt < expiresAt) {
            expiresAt = entry.expiresAt;
          }
        }
        if (expiresAt === undefined) return;
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm === null || expiresAt < currentAlarm) {
          await this.ctx.storage.setAlarm(expiresAt);
        }
      })()
    );
  }

  private expirePendingCommands(now: number): void {
    // Track correlationIds already delivered in-memory so the durable
    // sweep does not double-deliver to the same web socket.
    const deliveredInMemory = new Set<string>();
    for (const [id, entry] of this.pendingCommands) {
      if (entry.expiresAt > now) continue;
      this.pendingCommands.delete(id);
      // Reserve the correlationId so a concurrent finishDurablePendingCommands
      // (from failPendingCommandsForSocket/failPendingCommandsForOwnerChange)
      // does not double-deliver the same terminal response.  But if a
      // concurrent path already reserved it, skip — that path owns delivery.
      if (this.completedCorrelationIds.has(id)) {
        deliveredInMemory.add(id);
        continue;
      }
      deliveredInMemory.add(id);
      this.completedCorrelationIds.add(id);
      this.sendToWeb(entry.ws, {
        type: 'response',
        id: entry.originalId,
        error: COMMAND_EXPIRED_ERROR,
      });
    }

    // Step 26: sweep durable entries. Pending entries past their TTL are
    // marked done with COMMAND_EXPIRED_ERROR; already-done entries are
    // cleaned up via deletion.
    this.ctx.waitUntil(
      (async () => {
        const entries = await this.ctx.storage.list<PendingCommandEntry>({
          prefix: PENDING_COMMAND_KEY_PREFIX,
        });
        for (const [key, durable] of entries) {
          if (!durable || typeof durable.expiresAt !== 'number') continue;
          if (durable.expiresAt > now) continue;

          if (durable.state === 'pending') {
            const correlationId = key.slice(PENDING_COMMAND_KEY_PREFIX.length);
            // Entries already delivered in the in-memory sweep above still need
            // the durable 'done' mark, but should not claim or send again.
            if (deliveredInMemory.has(correlationId)) {
              await this.ctx.storage.put(key, {
                ...durable,
                state: 'done',
                error: COMMAND_EXPIRED_ERROR,
              });
              continue;
            }
            // Claim the correlation BEFORE the durable put so a concurrent
            // sweep with a stale list snapshot cannot pass through its
            // awaited put and send after we already delivered.
            if (this.completedCorrelationIds.has(correlationId)) continue;
            this.completedCorrelationIds.add(correlationId);

            try {
              await this.ctx.storage.put(key, {
                ...durable,
                state: 'done',
                error: COMMAND_EXPIRED_ERROR,
              });
            } catch (_error: unknown) {
              // On storage failure: release the claim so a retry or another
              // concurrent path can deliver.
              this.completedCorrelationIds.delete(correlationId);
              console.error('Failed to persist expirePendingCommands terminal outcome', {
                correlationId,
                error: _error instanceof Error ? _error.message : String(_error),
              });
              continue;
            }

            // Deliver the terminal response to a live matching web socket
            // that reconnected after the original socket disconnected (D8 case 3).
            const webWs = this.findWebByConnectionId(durable.webConnectionId);
            if (webWs) {
              this.sendToWeb(webWs, {
                type: 'response',
                id: durable.originalId,
                error: COMMAND_EXPIRED_ERROR,
              });
            }
          } else {
            // Already done and past TTL: clean up. Release the completion
            // marker so cross-sweep dedupe state does not accumulate through
            // repeated TTL cleanup.
            const correlationId = key.slice(PENDING_COMMAND_KEY_PREFIX.length);
            await this.ctx.storage.delete(key);
            this.completedCorrelationIds.delete(correlationId);
          }
        }
      })().catch((error: unknown) => {
        console.error('Failed to sweep durable pending commands', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  private scheduleNextAlarm(now: number): void {
    // Post-eviction one-shot: rebuild readyPushFireAt from KV when the mirror
    // is empty and we have not yet successfully refreshed this wake.
    if (this.readyPushFireAt.size === 0 && !this.readyPushRebuilt) {
      this.ctx.waitUntil(
        (async () => {
          try {
            const pending = await this.ctx.storage.list<ReadyPushEntry>({
              prefix: READY_PUSH_KEY_PREFIX,
            });
            for (const [key, entry] of pending) {
              if (!entry || typeof entry.fireAt !== 'number') continue;
              const sessionId = key.slice(READY_PUSH_KEY_PREFIX.length);
              if (sessionId) this.readyPushFireAt.set(sessionId, entry.fireAt);
            }
            this.readyPushRebuilt = true;
            this.scheduleNextAlarm(Date.now());
          } catch (error: unknown) {
            // Leave readyPushRebuilt false so the next schedule retries.
            console.error('Failed to rebuild readyPush mirror', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })()
      );
    }

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

    // readyPush entries are NEVER filtered by fireAt > now: if any exists and
    // min(fireAt) <= now, arm at now (immediate fire). Arm whenever any
    // readyPush exists, even with zero heartbeat/pending candidates.
    if (this.readyPushFireAt.size > 0) {
      let minFireAt = Infinity;
      for (const fireAt of this.readyPushFireAt.values()) {
        if (fireAt < minFireAt) minFireAt = fireAt;
      }
      const readyAt = minFireAt <= now ? now : minFireAt;
      if (nextAlarmAt === undefined || readyAt < nextAlarmAt) {
        nextAlarmAt = readyAt;
      }
    }

    if (nextAlarmAt !== undefined) {
      void this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }

  private aggregateSessions(): Array<
    HeartbeatSession & {
      connectionId: string;
      protocolVersion?: string;
      capabilities?: ConnectionCapabilities;
    }
  > {
    // Build set of connectionIds that still have a live CLI WebSocket.
    // This guards against stale entries that persist if a close event is delayed.
    const liveConnectionIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets('cli')) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.role === 'cli') liveConnectionIds.add(att.connectionId);
    }

    const result: Array<
      HeartbeatSession & {
        connectionId: string;
        protocolVersion?: string;
        capabilities?: ConnectionCapabilities;
      }
    > = [];
    for (const [connectionId, sessions] of this.connectionSessions) {
      if (!liveConnectionIds.has(connectionId)) continue;
      const protocolVersion = this.connectionProtocolVersion.get(connectionId);
      const capabilities = this.connectionCapabilities.get(connectionId);
      for (const session of sessions) {
        if (session.parentSessionId) continue;
        // Owner-unique: only emit a row for a session id under its current owner,
        // so a session that has transferred owners while both CLIs are still
        // connected does not appear twice in the snapshot.
        if (this.sessionOwners.get(session.id) !== connectionId) continue;
        result.push({
          ...session,
          connectionId,
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(capabilities ? { capabilities } : {}),
          // Preserve byte-identical responses for legacy senders that never
          // include a `platform`: only forward the field when present.
          ...(session.platform ? { platform: session.platform } : {}),
        });
      }
    }
    return result;
  }
}

export function getUserConnectionDO(env: Env, params: { kiloUserId: string }) {
  const id = env.USER_CONNECTION_DO.idFromName(params.kiloUserId);
  return env.USER_CONNECTION_DO.get(id);
}
