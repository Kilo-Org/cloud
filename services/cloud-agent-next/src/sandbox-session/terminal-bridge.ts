import { timingSafeEqual } from '@kilocode/encryption';
import { z } from 'zod';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  responseFrameSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalConnectResultSchema,
  terminalPtyIdSchema,
  wrapperInstanceIdSchema,
  type ResponseFrame,
  type SessionTerminalConnectPayload,
} from '../shared/sandbox-control-protocol.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
} from '../sandbox-control/credential.js';
import { getSessionWorkspacePath } from '../workspace.js';

const TERMINAL_TAG = 'terminal';
const TERMINAL_CAPABILITY_LIFETIME_MS = 45_000;
const TERMINAL_ACTIVITY_INTERVAL_MS = 30_000;
const MAX_TERMINAL_FRAME_BYTES = 256 * 1024;
const MAX_CLOSE_REASON_BYTES = 123;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const TERMINAL_ENDED_REASON = 'PTY session ended';
const encoder = new TextEncoder();

export type SandboxTerminalRecord = {
  ptyId: string;
  ownerId: string;
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  sandboxId: string;
  wrapperInstanceId: string;
  organizationId?: string;
  state: 'running' | 'ended';
};

type SandboxTerminalBridgeOptions = {
  state: DurableObjectState;
  getMetadata: () => Promise<SessionMetadata | null>;
  getTerminal: (ptyId: string) => Promise<SandboxTerminalRecord | undefined>;
  requestConnect: (
    record: SandboxTerminalRecord,
    payload: SessionTerminalConnectPayload
  ) => Promise<ResponseFrame>;
  reportActivity: (record: SandboxTerminalRecord) => Promise<void>;
  markEnded: (record: SandboxTerminalRecord) => Promise<void>;
};

const terminalSocketAttachmentSchema = z
  .object({
    role: z.enum(['browser', 'wrapper']),
    ptyId: terminalPtyIdSchema,
    bridgeGeneration: z.string().uuid(),
    wrapperInstanceId: wrapperInstanceIdSchema,
    capabilityHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    capabilityExpiresAt: z.number().int().nonnegative().optional(),
    lastActivityReportedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

type TerminalSocketAttachment = z.infer<typeof terminalSocketAttachmentSchema>;

type TerminalSocket = {
  socket: WebSocket;
  attachment: TerminalSocketAttachment;
};

function readAttachment(socket: WebSocket): TerminalSocketAttachment | null {
  const parsed = terminalSocketAttachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

function socketTag(role: TerminalSocketAttachment['role'], ptyId: string): string {
  return `${TERMINAL_TAG}:${role}:${ptyId}`;
}

function parseInternalPtyId(request: Request, pathname: string): string | null {
  const url = new URL(request.url);
  if (url.pathname !== pathname) return null;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== 'ptyId') return null;
  const parsed = terminalPtyIdSchema.safeParse(entries[0][1]);
  return parsed.success ? parsed.data : null;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

function normalizeCloseCode(code: number): number {
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) {
    return code;
  }
  return 1011;
}

function normalizeCloseReason(reason: string): string {
  const bytes = encoder.encode(reason);
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  return new TextDecoder().decode(bytes.subarray(0, MAX_CLOSE_REASON_BYTES), { stream: true });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(normalizeCloseCode(code), normalizeCloseReason(reason));
  } catch {
    return;
  }
}

function revokePendingCapability(socket: WebSocket, attachment: TerminalSocketAttachment): void {
  if (
    attachment.role !== 'browser' ||
    (attachment.capabilityHash === undefined && attachment.capabilityExpiresAt === undefined)
  ) {
    return;
  }
  const revoked = { ...attachment };
  delete revoked.capabilityHash;
  delete revoked.capabilityExpiresAt;
  socket.serializeAttachment(revoked);
}

function sameGeneration(
  first: TerminalSocketAttachment,
  second: TerminalSocketAttachment
): boolean {
  return (
    first.ptyId === second.ptyId &&
    first.bridgeGeneration === second.bridgeGeneration &&
    first.wrapperInstanceId === second.wrapperInstanceId
  );
}

export function createSandboxTerminalBridge(options: SandboxTerminalBridgeOptions) {
  const { state, getMetadata, getTerminal, requestConnect, reportActivity, markEnded } = options;

  function currentSocket(
    role: TerminalSocketAttachment['role'],
    ptyId: string
  ): TerminalSocket | null {
    for (const socket of state.getWebSockets(socketTag(role, ptyId))) {
      if (socket.readyState !== SOCKET_OPEN) continue;
      const attachment = readAttachment(socket);
      if (attachment?.role === role && attachment.ptyId === ptyId) {
        return { socket, attachment };
      }
    }
    return null;
  }

  function recordMatchesMetadata(
    record: SandboxTerminalRecord | undefined,
    metadata: SessionMetadata | null,
    ptyId: string
  ): record is SandboxTerminalRecord {
    if (
      !record ||
      !metadata ||
      record.ptyId !== ptyId ||
      record.ownerId !== metadata.identity.userId ||
      record.sessionId !== metadata.identity.sessionId ||
      !record.sessionId.startsWith('workspace_') ||
      record.kiloSessionId !== metadata.auth.kiloSessionId ||
      record.sandboxId !== metadata.workspace?.sandboxId ||
      (record.organizationId ?? null) !== (metadata.identity.orgId ?? null) ||
      !wrapperInstanceIdSchema.safeParse(record.wrapperInstanceId).success
    ) {
      return false;
    }

    const durableObjectName = state.id.name;
    if (durableObjectName && durableObjectName !== `${record.ownerId}:${record.sessionId}`) {
      return false;
    }

    try {
      const directory =
        metadata.workspace?.workspacePath ??
        getSessionWorkspacePath(
          metadata.identity.orgId,
          metadata.identity.userId,
          metadata.identity.sessionId
        );
      return record.directory === directory;
    } catch {
      return false;
    }
  }

  function closeSockets(sockets: WebSocket[], code: number, reason: string): void {
    for (const socket of sockets) {
      const attachment = readAttachment(socket);
      if (attachment) revokePendingCapability(socket, attachment);
    }
    for (const socket of sockets) closeSocket(socket, code, reason);
  }

  function closeGeneration(
    attachment: TerminalSocketAttachment,
    code: number,
    reason: string
  ): void {
    const sockets = state.getWebSockets(TERMINAL_TAG).filter(socket => {
      const current = readAttachment(socket);
      return current !== null && sameGeneration(current, attachment);
    });
    closeSockets(sockets, code, reason);
  }

  function closeTerminal(ptyId: string, code = 1000, reason = TERMINAL_ENDED_REASON): void {
    const sockets = [
      ...state.getWebSockets(socketTag('browser', ptyId)),
      ...state.getWebSockets(socketTag('wrapper', ptyId)),
    ];
    closeSockets(sockets, code, reason);
  }

  function closeAll(code = 1000, reason = TERMINAL_ENDED_REASON): void {
    closeSockets(state.getWebSockets(TERMINAL_TAG), code, reason);
  }

  function closeRuntime(
    wrapperInstanceId: string,
    code = 1000,
    reason = TERMINAL_ENDED_REASON
  ): void {
    const sockets = state
      .getWebSockets(TERMINAL_TAG)
      .filter(socket => readAttachment(socket)?.wrapperInstanceId === wrapperInstanceId);
    closeSockets(sockets, code, reason);
  }

  function reportSocketActivity(socket: WebSocket, attachment: TerminalSocketAttachment): void {
    const now = Date.now();
    if (
      attachment.lastActivityReportedAt !== undefined &&
      now - attachment.lastActivityReportedAt < TERMINAL_ACTIVITY_INTERVAL_MS
    ) {
      return;
    }

    socket.serializeAttachment({ ...attachment, lastActivityReportedAt: now });
    state.waitUntil(
      (async () => {
        const [metadata, record] = await Promise.all([
          getMetadata(),
          getTerminal(attachment.ptyId),
        ]);
        const current = currentSocket(attachment.role, attachment.ptyId);
        if (
          !recordMatchesMetadata(record, metadata, attachment.ptyId) ||
          record.state !== 'running' ||
          record.wrapperInstanceId !== attachment.wrapperInstanceId ||
          current?.socket !== socket ||
          !sameGeneration(current.attachment, attachment)
        ) {
          return;
        }
        await reportActivity(record);
      })().catch(() => undefined)
    );
  }

  async function handleBrowserUpgrade(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const ptyId = parseInternalPtyId(request, '/terminal/browser');
    if (!ptyId) return new Response('Invalid PTY ID', { status: 400 });

    const [metadata, record] = await Promise.all([getMetadata(), getTerminal(ptyId)]);
    if (!record || !metadata) return new Response('PTY not found', { status: 404 });
    if (!recordMatchesMetadata(record, metadata, ptyId)) {
      return new Response('Invalid terminal session', { status: 403 });
    }

    if (record.state === 'ended') {
      const pair = new WebSocketPair();
      const attachment: TerminalSocketAttachment = {
        role: 'browser',
        ptyId,
        bridgeGeneration: crypto.randomUUID(),
        wrapperInstanceId: record.wrapperInstanceId,
      };
      state.acceptWebSocket(pair[1], [TERMINAL_TAG, socketTag('browser', ptyId)]);
      pair[1].serializeAttachment(attachment);
      closeSocket(pair[1], 1000, TERMINAL_ENDED_REASON);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const capability = generateSandboxCredential();
    const capabilityHash = await hashSandboxCredential(capability);
    const [latestMetadata, latestRecord] = await Promise.all([getMetadata(), getTerminal(ptyId)]);
    if (
      !recordMatchesMetadata(latestRecord, latestMetadata, ptyId) ||
      latestRecord.state !== 'running' ||
      latestRecord.wrapperInstanceId !== record.wrapperInstanceId
    ) {
      return new Response('Terminal unavailable', { status: 409 });
    }

    const bridgeGeneration = crypto.randomUUID();
    const attachment: TerminalSocketAttachment = {
      role: 'browser',
      ptyId,
      bridgeGeneration,
      wrapperInstanceId: latestRecord.wrapperInstanceId,
      capabilityHash,
      capabilityExpiresAt: Date.now() + TERMINAL_CAPABILITY_LIFETIME_MS,
    };
    const pair = new WebSocketPair();
    closeTerminal(ptyId, 4000, 'Terminal connection replaced');
    state.acceptWebSocket(pair[1], [TERMINAL_TAG, socketTag('browser', ptyId)]);
    pair[1].serializeAttachment(attachment);

    try {
      const payload = sessionTerminalConnectPayloadSchema.parse({
        ownerId: latestRecord.ownerId,
        ptyId,
        bridgeGeneration,
        capability,
      });
      const response = responseFrameSchema.safeParse(await requestConnect(latestRecord, payload));
      if (
        !response.success ||
        !response.data.ok ||
        !sessionTerminalConnectResultSchema.safeParse(response.data.result).success
      ) {
        closeGeneration(attachment, 1011, 'Terminal connection failed');
        return new Response('Terminal connection failed', { status: 502 });
      }

      const [currentMetadata, currentRecord] = await Promise.all([
        getMetadata(),
        getTerminal(ptyId),
      ]);
      const browser = currentSocket('browser', ptyId);
      const wrapper = currentSocket('wrapper', ptyId);
      if (
        !recordMatchesMetadata(currentRecord, currentMetadata, ptyId) ||
        currentRecord.state !== 'running' ||
        currentRecord.wrapperInstanceId !== attachment.wrapperInstanceId ||
        browser?.socket !== pair[1] ||
        !wrapper ||
        !sameGeneration(browser.attachment, attachment) ||
        !sameGeneration(wrapper.attachment, attachment)
      ) {
        closeGeneration(attachment, 1011, 'Terminal connection replaced');
        return new Response('Terminal unavailable', { status: 409 });
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch {
      closeGeneration(attachment, 1011, 'Terminal connection failed');
      return new Response('Terminal connection failed', { status: 502 });
    }
  }

  async function handleWrapperUpgrade(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const ptyId = parseInternalPtyId(request, '/terminal/wrapper');
    if (!ptyId) return new Response('Invalid PTY ID', { status: 400 });

    const credential = parseBearerCredential(request.headers.get('Authorization'));
    if (credential === null) return new Response('Unauthorized', { status: 401 });

    const [metadata, record] = await Promise.all([getMetadata(), getTerminal(ptyId)]);
    if (!recordMatchesMetadata(record, metadata, ptyId) || record.state !== 'running') {
      return new Response('Unauthorized', { status: 401 });
    }

    const presentedHash = await hashSandboxCredential(credential);
    const browser = currentSocket('browser', ptyId);
    if (
      !browser ||
      browser.attachment.wrapperInstanceId !== record.wrapperInstanceId ||
      browser.attachment.capabilityHash === undefined ||
      browser.attachment.capabilityExpiresAt === undefined ||
      browser.attachment.capabilityExpiresAt <= Date.now() ||
      !timingSafeEqual(presentedHash, browser.attachment.capabilityHash)
    ) {
      return new Response('Unauthorized', { status: 401 });
    }

    const attachment: TerminalSocketAttachment = {
      role: 'wrapper',
      ptyId,
      bridgeGeneration: browser.attachment.bridgeGeneration,
      wrapperInstanceId: browser.attachment.wrapperInstanceId,
    };

    try {
      const pair = new WebSocketPair();
      revokePendingCapability(browser.socket, browser.attachment);
      state.acceptWebSocket(pair[1], [TERMINAL_TAG, socketTag('wrapper', ptyId)]);
      pair[1].serializeAttachment(attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch {
      closeGeneration(browser.attachment, 1011, 'Terminal connection failed');
      return new Response('Terminal connection failed', { status: 502 });
    }
  }

  async function handleMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) return;

    const current = currentSocket(attachment.role, attachment.ptyId);
    if (current?.socket !== socket) {
      if (current !== null || socket.readyState !== SOCKET_CLOSING) return;
    } else if (!sameGeneration(current.attachment, attachment)) {
      return;
    }

    const size =
      typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength;
    if (size > MAX_TERMINAL_FRAME_BYTES) {
      closeGeneration(attachment, 1009, 'Terminal frame too large');
      return;
    }

    const peer = currentSocket(
      attachment.role === 'browser' ? 'wrapper' : 'browser',
      attachment.ptyId
    );
    if (!peer || !sameGeneration(peer.attachment, attachment)) {
      closeGeneration(attachment, 1011, 'Terminal peer unavailable');
      return;
    }

    try {
      peer.socket.send(message);
    } catch {
      closeGeneration(attachment, 1011, 'Terminal connection failed');
      return;
    }

    if (socket.readyState === SOCKET_OPEN) reportSocketActivity(socket, attachment);
  }

  async function handleClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) return;

    if (attachment.role === 'browser') {
      revokePendingCapability(socket, attachment);
      closeSocket(socket, code, reason);
    }

    const currentRoleSocket = currentSocket(attachment.role, attachment.ptyId);
    if (currentRoleSocket && currentRoleSocket.socket !== socket) return;

    const peer = currentSocket(
      attachment.role === 'browser' ? 'wrapper' : 'browser',
      attachment.ptyId
    );
    if (!peer || !sameGeneration(peer.attachment, attachment)) return;

    if (attachment.role === 'browser') {
      closeSocket(peer.socket, code === 1000 ? 1000 : 1011, 'Browser disconnected');
      return;
    }

    if (code !== 1000) {
      revokePendingCapability(peer.socket, peer.attachment);
      closeSocket(peer.socket, 1011, 'Terminal connection failed');
      return;
    }

    try {
      const [metadata, record] = await Promise.all([getMetadata(), getTerminal(attachment.ptyId)]);
      const latestBrowser = currentSocket('browser', attachment.ptyId);
      if (
        !recordMatchesMetadata(record, metadata, attachment.ptyId) ||
        record.state !== 'running' ||
        record.wrapperInstanceId !== attachment.wrapperInstanceId ||
        !latestBrowser ||
        !sameGeneration(latestBrowser.attachment, attachment)
      ) {
        return;
      }

      await markEnded(record);
      const currentBrowser = currentSocket('browser', attachment.ptyId);
      if (currentBrowser && sameGeneration(currentBrowser.attachment, attachment)) {
        revokePendingCapability(currentBrowser.socket, currentBrowser.attachment);
        closeSocket(currentBrowser.socket, 1000, TERMINAL_ENDED_REASON);
      }
    } catch {
      const currentBrowser = currentSocket('browser', attachment.ptyId);
      if (currentBrowser && sameGeneration(currentBrowser.attachment, attachment)) {
        revokePendingCapability(currentBrowser.socket, currentBrowser.attachment);
        closeSocket(currentBrowser.socket, 1011, 'Terminal connection failed');
      }
    }
  }

  async function handleError(socket: WebSocket, _error: unknown): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) return;
    const current = currentSocket(attachment.role, attachment.ptyId);
    if (current && current.socket !== socket) return;
    closeGeneration(attachment, 1011, 'Terminal connection failed');
  }

  return {
    handleBrowserUpgrade,
    handleWrapperUpgrade,
    handleMessage,
    handleClose,
    handleError,
    closeTerminal,
    closeAll,
    closeRuntime,
  };
}
