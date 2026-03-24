import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import {
  CLIOutboundMessageSchema,
  type CLIInboundMessage,
  type WebInboundMessage,
  WebOutboundMessageSchema,
} from '../types/user-connection-protocol';

type HeartbeatSession = {
  id: string;
  status: string;
  title: string;
  gitUrl?: string;
  gitBranch?: string;
};

type WSAttachment =
  | { role: 'cli'; connectionId: string; sessions: HeartbeatSession[] }
  | { role: 'web'; connectionId: string; subscribedSessions: string[] };

export class UserConnectionDO extends DurableObject<Env> {
  private static readonly HEARTBEAT_TIMEOUT_MS = 30_000;

  // Which CLI connection owns each session
  private sessionOwners = new Map<string, string>();
  // Which web sockets want events for a session
  private webSubscriptions = new Map<string, Set<WebSocket>>();
  // Sessions per CLI connection (from heartbeat)
  private connectionSessions = new Map<string, HeartbeatSession[]>();
  // Pending command responses: correlationId → originating web socket
  private pendingCommands = new Map<
    string,
    { ws: WebSocket; sessionId?: string; originalId: string; targetCliWs: WebSocket }
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
        const { connectionId, sessions } = attachment;
        this.connectionSessions.set(connectionId, sessions);
        sessionCount += sessions.length;
        for (const session of sessions) {
          this.sessionOwners.set(session.id, connectionId);
        }
        this.lastHeartbeatAt.set(connectionId, Date.now());
      } else {
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
      this.lastHeartbeatAt.set(connectionId, Date.now());
      this.scheduleStaleCheck();

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

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('Failed to parse WebSocket message as JSON');
      return;
    }

    const attachment = ws.deserializeAttachment() as WSAttachment | null;
    if (!attachment) {
      console.warn('WebSocket message from socket with no attachment');
      return;
    }

    if (attachment.role === 'cli') {
      this.handleCliMessage(ws, attachment, parsed);
    } else {
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
    const staleConnectionIds: string[] = [];

    for (const [connectionId, lastSeen] of this.lastHeartbeatAt) {
      if (now - lastSeen > UserConnectionDO.HEARTBEAT_TIMEOUT_MS) {
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

    // If there are still active CLI connections, schedule another check
    if (this.lastHeartbeatAt.size > staleConnectionIds.length) {
      this.scheduleStaleCheck();
    }
  }

  // ---------------------------------------------------------------------------
  // CLI message handling
  // ---------------------------------------------------------------------------

  private handleCliMessage(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'cli' },
    parsed: unknown
  ): void {
    const result = CLIOutboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('CLI message parse failed', {
        connectionId: attachment.connectionId,
        errors: result.error.issues.map(i => i.message),
        raw: JSON.stringify(parsed).slice(0, 500),
      });
      return;
    }
    const msg = result.data;

    switch (msg.type) {
      case 'heartbeat':
        this.handleHeartbeat(ws, attachment, msg.sessions);
        break;
      case 'event':
        this.handleCliEvent(msg.sessionId, msg.parentSessionId, msg.event, msg.data);
        break;
      case 'response':
        this.handleCliResponse(msg.id, msg.result, msg.error);
        break;
    }
  }

  private handleHeartbeat(
    ws: WebSocket,
    attachment: WSAttachment & { role: 'cli' },
    sessions: HeartbeatSession[]
  ): void {
    const { connectionId } = attachment;
    this.lastHeartbeatAt.set(connectionId, Date.now());
    this.scheduleStaleCheck();

    // Remove sessions this connection previously owned but no longer reports
    const previousSessions = this.connectionSessions.get(connectionId) ?? [];
    const currentIds = new Set(sessions.map(s => s.id));
    for (const prev of previousSessions) {
      if (!currentIds.has(prev.id) && this.sessionOwners.get(prev.id) === connectionId) {
        this.sessionOwners.delete(prev.id);
      }
    }

    // Update ownership
    this.connectionSessions.set(connectionId, sessions);
    for (const session of sessions) {
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
    const updatedAttachment: WSAttachment = { role: 'cli', connectionId, sessions };
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
        data: { connectionId, sessions },
      };
      for (const ws2 of subscribers) {
        this.sendToWeb(ws2, msg);
      }
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

  private handleCliResponse(id: string, result: unknown, error: unknown): void {
    const entry = this.pendingCommands.get(id);
    if (!entry) return;
    this.pendingCommands.delete(id);

    this.sendToWeb(entry.ws, {
      type: 'response',
      id: entry.originalId,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
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
    // Find target CLI
    let targetCli: WebSocket | undefined;

    if (msg.connectionId) {
      // Route to specific CLI by connectionId
      for (const cliWs of this.ctx.getWebSockets('cli')) {
        const att = cliWs.deserializeAttachment() as WSAttachment | null;
        if (att?.role === 'cli' && att.connectionId === msg.connectionId) {
          targetCli = cliWs;
          break;
        }
      }
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

    const correlationId = crypto.randomUUID();
    this.pendingCommands.set(correlationId, {
      ws,
      sessionId: msg.sessionId,
      originalId: msg.id,
      targetCliWs: targetCli,
    });

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

  getActiveSessions(): Array<HeartbeatSession & { connectionId: string }> {
    this.ensureState();
    return this.aggregateSessions();
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
    for (const ws of this.ctx.getWebSockets('web')) {
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
        // Preserve session ownership — the reconnecting CLI still owns these sessions
        ws.close(1000, 'replaced by reconnect');
        return true;
      }
    }
    return false;
  }

  private findCliForSession(sessionId: string): WebSocket | undefined {
    const ownerConnectionId = this.sessionOwners.get(sessionId);
    if (!ownerConnectionId) return undefined;

    for (const ws of this.ctx.getWebSockets('cli')) {
      const attachment = ws.deserializeAttachment() as WSAttachment | null;
      if (attachment?.role === 'cli' && attachment.connectionId === ownerConnectionId) {
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
          error: 'CLI disconnected',
        });
        this.pendingCommands.delete(id);
      }
    }
  }

  private scheduleStaleCheck(): void {
    // Schedule an alarm to run after the timeout period.
    // setAlarm is idempotent if one is already scheduled sooner.
    void this.ctx.storage.setAlarm(Date.now() + UserConnectionDO.HEARTBEAT_TIMEOUT_MS);
  }

  private aggregateSessions(): Array<HeartbeatSession & { connectionId: string }> {
    // Build set of connectionIds that still have a live CLI WebSocket.
    // This guards against stale entries that persist if a close event is delayed.
    const liveConnectionIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets('cli')) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.role === 'cli') liveConnectionIds.add(att.connectionId);
    }

    const result: Array<HeartbeatSession & { connectionId: string }> = [];
    for (const [connectionId, sessions] of this.connectionSessions) {
      if (!liveConnectionIds.has(connectionId)) continue;
      for (const session of sessions) {
        result.push({ ...session, connectionId });
      }
    }
    return result;
  }
}

export function getUserConnectionDO(env: Env, params: { kiloUserId: string }) {
  const id = env.USER_CONNECTION_DO.idFromName(params.kiloUserId);
  return env.USER_CONNECTION_DO.get(id);
}
