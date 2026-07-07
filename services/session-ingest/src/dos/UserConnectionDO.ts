import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import {
  CLIOutboundMessageSchema,
  type CLIInboundMessage,
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
};

type WSAttachment =
  | {
      role: 'cli';
      connectionId: string;
      sessions: HeartbeatSession[];
      // Undefined means no protocolVersion has been reported yet — either the
      // CLI hasn't sent its first heartbeat, or it's a legacy build that
      // predates this field entirely. Both cases fall back to legacy behavior.
      protocolVersion?: string;
    }
  | { role: 'web'; connectionId: string; subscribedSessions: string[]; replaced?: true };

export const MAX_CATALOG_RESULT_BYTES = 512 * 1024;

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

  // Which CLI connection owns each session
  private sessionOwners = new Map<string, string>();
  // Which web sockets want events for a session
  private webSubscriptions = new Map<string, Set<WebSocket>>();
  // Sessions per CLI connection (from heartbeat)
  private connectionSessions = new Map<string, HeartbeatSession[]>();
  // Protocol version per CLI connection (from heartbeat); absent = legacy CLI
  private connectionProtocolVersion = new Map<string, string | undefined>();
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
  // Last heartbeat timestamp per CLI connectionId (for staleness eviction)
  private lastHeartbeatAt = new Map<string, number>();

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
        const { connectionId, sessions, protocolVersion } = attachment;
        this.connectionSessions.set(connectionId, sessions);
        this.connectionProtocolVersion.set(connectionId, protocolVersion);
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

      const attachment: WSAttachment = { role: 'cli', connectionId, sessions: [] };
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
      // via the webSocketClose callback
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
        this.handleHeartbeat(ws, attachment, msg.sessions, msg.protocolVersion);
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
    protocolVersion: string | undefined
  ): void {
    const { connectionId } = attachment;
    const now = Date.now();
    this.lastHeartbeatAt.set(connectionId, now);
    this.connectionProtocolVersion.set(connectionId, protocolVersion);
    this.scheduleNextAlarm(now);

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
      this.sessionOwners.set(session.id, connectionId);
    }

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

    this.sendToCli(ws, { type: 'heartbeat_ack' });
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

    if (entry.command === 'list_models' && result !== undefined) {
      const serializedResult = JSON.stringify(result);
      const resultBytes = new TextEncoder().encode(serializedResult).byteLength;
      if (resultBytes > MAX_CATALOG_RESULT_BYTES) {
        this.sendToWeb(entry.ws, {
          type: 'response',
          id: entry.originalId,
          error: CATALOG_TOO_LARGE_ERROR,
        });
        return;
      }
    }

    this.sendToWeb(entry.ws, {
      type: 'response',
      id: entry.originalId,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined
        ? { error: typeof error === 'string' ? error : CLI_COMMAND_ERROR }
        : {}),
    });
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

    console.log('CLI socket disconnected', {
      connectionId,
      droppedSessions: ownedSessions.size,
      remainingCliSockets: this.ctx.getWebSockets('cli').length,
    });

    // Leave webSubscriptions intact — a reconnecting CLI can resume

    this.broadcastToWeb({
      type: 'system',
      event: 'cli.disconnected',
      data: { connectionId },
    });
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
      if (entry.targetCliWs === targetWs) {
        this.sendToWeb(entry.ws, {
          type: 'response',
          id: entry.originalId,
          error: entry.expectedOwnerConnectionId ? SESSION_OWNER_CHANGED_ERROR : 'CLI disconnected',
        });
        this.pendingCommands.delete(id);
      }
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

export function getUserConnectionDO(env: Env, params: { kiloUserId: string }) {
  const id = env.USER_CONNECTION_DO.idFromName(params.kiloUserId);
  return env.USER_CONNECTION_DO.get(id);
}
