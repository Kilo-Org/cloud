import {
  sessionTerminalCreateResultSchema,
  sessionTerminalResizeResultSchema,
  type ControlErrorCode,
  type SessionRequestIdentity,
  type SessionTerminalClosePayload,
  type SessionTerminalCloseResult,
  type SessionTerminalConnectPayload,
  type SessionTerminalConnectResult,
  type SessionTerminalCreatePayload,
  type SessionTerminalCreateResult,
  type SessionTerminalResizePayload,
  type SessionTerminalResizeResult,
} from '../../../src/shared/sandbox-control-protocol.js';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from '../../../src/shared/runtime-environment.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { directoryForSession, forgetAttachedRoot, rootForSession } from './session-directories.js';

type AttachedTerminalSession = SessionRequestIdentity & {
  wrapperInstanceId: string;
};

type OwnedTerminal = AttachedTerminalSession & {
  ptyId: string;
  operationId: string;
  ownerId?: string;
  state: 'running' | 'ended';
};

type TerminalCreationOperation = AttachedTerminalSession & {
  cols?: number;
  rows?: number;
  promise: Promise<SessionTerminalCreateResult>;
};

type TerminalBridge = {
  terminal: OwnedTerminal;
  ownerId: string;
  bridgeGeneration: string;
  reverse: WebSocket;
  local?: WebSocket;
  connection?: Promise<SessionTerminalConnectResult>;
  closing: boolean;
};

type AuthenticatedWebSocketConstructor = typeof WebSocket & {
  new (url: string, options: { headers: Record<string, string> }): WebSocket;
};

const MAX_TERMINAL_BUFFERED_BYTES = 1024 * 1024;

const WORKSPACE_TERMINAL_ENV = {
  PROMPT_COMMAND: "PS1='\\n\\W\\n\\$ '",
  PS1: '\\n\\W\\n\\$ ',
  [PNPM_STORE_ENV_VAR]: PNPM_STORE_DIR,
  SANDBOX_CONTROL_CREDENTIAL: '',
} satisfies Record<string, string>;

export class ControlTerminalRuntimeError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ControlTerminalRuntimeError';
  }
}

export type ControlTerminalRuntime = {
  rememberAttachedSession(identity: SessionRequestIdentity): void;
  detachSession(identity: SessionRequestIdentity): Promise<void>;
  create(
    identity: SessionRequestIdentity,
    payload: SessionTerminalCreatePayload
  ): Promise<SessionTerminalCreateResult>;
  resize(
    identity: SessionRequestIdentity,
    payload: SessionTerminalResizePayload
  ): Promise<SessionTerminalResizeResult>;
  close(
    identity: SessionRequestIdentity,
    payload: SessionTerminalClosePayload
  ): Promise<SessionTerminalCloseResult>;
  connect(
    identity: SessionRequestIdentity,
    payload: SessionTerminalConnectPayload
  ): Promise<SessionTerminalConnectResult>;
  shutdown(): void;
};

function sameSession(left: SessionRequestIdentity, right: SessionRequestIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.kiloSessionId === right.kiloSessionId &&
    left.directory === right.directory
  );
}

function safeKiloFailure(error: unknown, message: string): ControlTerminalRuntimeError {
  if (error instanceof ControlTerminalRuntimeError) return error;
  return new ControlTerminalRuntimeError('not_ready', message, isKiloServerUnreachableError(error));
}

function closeSocket(socket: WebSocket | undefined, code: number, reason: string): void {
  if (
    !socket ||
    (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN)
  ) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    return;
  }
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(
      new ControlTerminalRuntimeError('not_ready', 'Terminal transport failed', true)
    );
  }

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onFailure = () => {
      cleanup();
      reject(new ControlTerminalRuntimeError('not_ready', 'Terminal transport failed', true));
    };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFailure);
      socket.removeEventListener('close', onFailure);
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onFailure);
    socket.addEventListener('close', onFailure);
  });
}

export function createControlTerminalRuntime(options: {
  controlUrl: string;
  wrapperInstanceId: string;
  kiloClient: WrapperKiloClient;
}): ControlTerminalRuntime {
  const { wrapperInstanceId, kiloClient } = options;
  const controlOrigin = new URL(options.controlUrl).origin;
  const attachedSessions = new Map<string, AttachedTerminalSession>();
  const terminals = new Map<string, OwnedTerminal>();
  const operations = new Map<string, TerminalCreationOperation>();
  const bridges = new Map<string, TerminalBridge>();
  let shutDown = false;

  function requireAttached(identity: SessionRequestIdentity): AttachedTerminalSession {
    const attached = attachedSessions.get(identity.sessionId);
    if (!attached || shutDown) {
      throw new ControlTerminalRuntimeError('not_ready', 'Terminal session is not attached', true);
    }
    if (
      attached.wrapperInstanceId !== wrapperInstanceId ||
      !sameSession(attached, identity) ||
      directoryForSession(identity.kiloSessionId) !== identity.directory ||
      rootForSession(identity.kiloSessionId) !== identity.kiloSessionId ||
      rootForSession(undefined, identity.directory) !== identity.kiloSessionId
    ) {
      throw new ControlTerminalRuntimeError(
        'unauthorized',
        'Terminal session ownership mismatch',
        false
      );
    }
    return attached;
  }

  function requireTerminal(
    identity: SessionRequestIdentity,
    ptyId: string,
    allowEnded = false
  ): OwnedTerminal {
    const attached = requireAttached(identity);
    const terminal = terminals.get(ptyId);
    if (
      !terminal ||
      terminal.wrapperInstanceId !== attached.wrapperInstanceId ||
      !sameSession(terminal, attached)
    ) {
      throw new ControlTerminalRuntimeError('unauthorized', 'Terminal ownership mismatch', false);
    }
    if (!allowEnded && terminal.state !== 'running') {
      throw new ControlTerminalRuntimeError('not_ready', 'PTY session ended', false);
    }
    return terminal;
  }

  function isCurrentBridge(bridge: TerminalBridge): boolean {
    return (
      !bridge.closing &&
      bridges.get(bridge.terminal.ptyId) === bridge &&
      terminals.get(bridge.terminal.ptyId) === bridge.terminal &&
      attachedSessions.get(bridge.terminal.sessionId)?.wrapperInstanceId === wrapperInstanceId
    );
  }

  function closeBridge(bridge: TerminalBridge, code: number, reason: string): void {
    if (bridge.closing) return;
    bridge.closing = true;
    if (bridges.get(bridge.terminal.ptyId) === bridge) {
      bridges.delete(bridge.terminal.ptyId);
    }
    closeSocket(bridge.reverse, code, reason);
    closeSocket(bridge.local, code, reason);
  }

  function forwardMessage(
    bridge: TerminalBridge,
    target: WebSocket | undefined,
    data: unknown
  ): void {
    if (!isCurrentBridge(bridge)) return;
    if (
      !target ||
      target.readyState !== WebSocket.OPEN ||
      (typeof data !== 'string' && !(data instanceof ArrayBuffer))
    ) {
      closeBridge(bridge, 1011, 'Terminal transport failed');
      return;
    }

    const messageBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (messageBytes > MAX_TERMINAL_BUFFERED_BYTES) {
      closeBridge(bridge, 1009, 'Terminal message too large');
      return;
    }
    if (target.bufferedAmount + messageBytes > MAX_TERMINAL_BUFFERED_BYTES) {
      closeBridge(bridge, 1011, 'Terminal transport overloaded');
      return;
    }

    try {
      target.send(data);
    } catch {
      closeBridge(bridge, 1011, 'Terminal transport failed');
    }
  }

  async function createTerminal(
    attached: AttachedTerminalSession,
    payload: SessionTerminalCreatePayload
  ): Promise<SessionTerminalCreateResult> {
    let createdPtyId: string | undefined;
    try {
      const created = await kiloClient.createPty({
        cwd: attached.directory,
        title: 'Workspace terminal',
        env: WORKSPACE_TERMINAL_ENV,
      });
      createdPtyId = created.id;
      if (attachedSessions.get(attached.sessionId) !== attached) {
        throw new ControlTerminalRuntimeError(
          'not_ready',
          'Terminal session is no longer attached',
          false
        );
      }

      const pty =
        payload.cols !== undefined && payload.rows !== undefined
          ? await kiloClient.resizePty(
              created.id,
              { cols: payload.cols, rows: payload.rows },
              attached.directory
            )
          : created;
      if (attachedSessions.get(attached.sessionId) !== attached) {
        throw new ControlTerminalRuntimeError(
          'not_ready',
          'Terminal session is no longer attached',
          false
        );
      }

      const result = sessionTerminalCreateResultSchema.safeParse({ pty });
      if (
        !result.success ||
        result.data.pty.id !== created.id ||
        result.data.pty.cwd !== attached.directory
      ) {
        throw new ControlTerminalRuntimeError('protocol_error', 'Invalid terminal response', false);
      }
      if (terminals.has(created.id)) {
        throw new ControlTerminalRuntimeError('unauthorized', 'Terminal ownership mismatch', false);
      }

      terminals.set(created.id, {
        ...attached,
        ptyId: created.id,
        operationId: payload.operationId,
        state: 'running',
      });
      return result.data;
    } catch (error) {
      if (createdPtyId !== undefined) {
        await kiloClient.deletePty(createdPtyId, attached.directory).catch(() => undefined);
      }
      throw safeKiloFailure(error, 'Terminal creation failed');
    }
  }

  async function establishBridge(bridge: TerminalBridge): Promise<SessionTerminalConnectResult> {
    try {
      await waitForSocketOpen(bridge.reverse);
      if (!isCurrentBridge(bridge)) {
        throw new ControlTerminalRuntimeError(
          'not_ready',
          'Terminal connection was replaced',
          true
        );
      }

      const localUrl = new URL(
        `/pty/${encodeURIComponent(bridge.terminal.ptyId)}/connect`,
        kiloClient.serverUrl
      );
      localUrl.protocol = localUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      localUrl.search = '';
      localUrl.hash = '';
      localUrl.searchParams.set('directory', bridge.terminal.directory);

      const local = new WebSocket(localUrl.toString());
      local.binaryType = 'arraybuffer';
      bridge.local = local;
      local.onmessage = event => forwardMessage(bridge, bridge.reverse, event.data);
      local.onerror = () => {
        if (isCurrentBridge(bridge)) closeBridge(bridge, 1011, 'Terminal transport failed');
      };
      local.onclose = event => {
        if (!isCurrentBridge(bridge)) return;
        if (event.code === 1000) {
          bridge.terminal.state = 'ended';
          closeBridge(bridge, 1000, 'PTY session ended');
          return;
        }
        closeBridge(bridge, 1011, 'Terminal transport failed');
      };

      await waitForSocketOpen(local);
      if (!isCurrentBridge(bridge)) {
        throw new ControlTerminalRuntimeError(
          'not_ready',
          'Terminal connection was replaced',
          true
        );
      }
      return { connected: true };
    } catch (error) {
      closeBridge(bridge, 1011, 'Terminal transport failed');
      if (error instanceof ControlTerminalRuntimeError) throw error;
      throw new ControlTerminalRuntimeError('not_ready', 'Terminal transport failed', true);
    }
  }

  return {
    rememberAttachedSession(identity) {
      if (
        shutDown ||
        directoryForSession(identity.kiloSessionId) !== identity.directory ||
        rootForSession(identity.kiloSessionId) !== identity.kiloSessionId ||
        rootForSession(undefined, identity.directory) !== identity.kiloSessionId
      ) {
        throw new ControlTerminalRuntimeError(
          'unauthorized',
          'Terminal session ownership mismatch',
          false
        );
      }

      const existing = attachedSessions.get(identity.sessionId);
      if (existing) {
        if (!sameSession(existing, identity)) {
          throw new ControlTerminalRuntimeError(
            'unauthorized',
            'Terminal session ownership mismatch',
            false
          );
        }
        return;
      }

      for (const attached of attachedSessions.values()) {
        if (
          attached.kiloSessionId === identity.kiloSessionId ||
          attached.directory === identity.directory
        ) {
          throw new ControlTerminalRuntimeError(
            'unauthorized',
            'Terminal session ownership mismatch',
            false
          );
        }
      }

      attachedSessions.set(identity.sessionId, { ...identity, wrapperInstanceId });
    },

    async detachSession(identity) {
      const attached = attachedSessions.get(identity.sessionId);
      if (!attached) return;
      if (!sameSession(attached, identity)) {
        throw new ControlTerminalRuntimeError(
          'unauthorized',
          'Terminal session ownership mismatch',
          false
        );
      }

      attachedSessions.delete(identity.sessionId);
      forgetAttachedRoot(identity.kiloSessionId, identity.directory);

      const pending: Promise<unknown>[] = [];
      for (const [operationId, operation] of operations) {
        if (!sameSession(operation, attached)) continue;
        operations.delete(operationId);
        pending.push(operation.promise);
      }

      for (const [ptyId, terminal] of terminals) {
        if (!sameSession(terminal, attached)) continue;
        const bridge = bridges.get(ptyId);
        if (bridge) closeBridge(bridge, 1000, 'PTY session ended');
        terminals.delete(ptyId);
        pending.push(kiloClient.deletePty(ptyId, terminal.directory));
      }

      await Promise.allSettled(pending);
    },

    async create(identity, payload) {
      const existing = operations.get(payload.operationId);
      if (existing) {
        if (
          existing.wrapperInstanceId !== wrapperInstanceId ||
          !sameSession(existing, identity) ||
          existing.cols !== payload.cols ||
          existing.rows !== payload.rows
        ) {
          throw new ControlTerminalRuntimeError(
            'idempotency_conflict',
            'Terminal operation identity mismatch',
            false
          );
        }
        requireAttached(identity);
        return existing.promise;
      }

      const attached = requireAttached(identity);
      const promise = Promise.resolve().then(() => createTerminal(attached, payload));
      const operation: TerminalCreationOperation = {
        ...attached,
        ...(payload.cols !== undefined ? { cols: payload.cols } : {}),
        ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
        promise,
      };
      operations.set(payload.operationId, operation);
      void promise.catch(() => {
        if (operations.get(payload.operationId) === operation) {
          operations.delete(payload.operationId);
        }
      });
      return promise;
    },

    async resize(identity, payload) {
      const terminal = requireTerminal(identity, payload.ptyId);
      try {
        const pty = await kiloClient.resizePty(
          payload.ptyId,
          { cols: payload.cols, rows: payload.rows },
          terminal.directory
        );
        if (terminals.get(payload.ptyId) !== terminal) {
          throw new ControlTerminalRuntimeError(
            'unauthorized',
            'Terminal ownership mismatch',
            false
          );
        }
        const result = sessionTerminalResizeResultSchema.safeParse({ pty });
        if (
          !result.success ||
          result.data.pty.id !== payload.ptyId ||
          result.data.pty.cwd !== terminal.directory
        ) {
          throw new ControlTerminalRuntimeError(
            'protocol_error',
            'Invalid terminal response',
            false
          );
        }
        return result.data;
      } catch (error) {
        throw safeKiloFailure(error, 'Terminal resize failed');
      }
    },

    async close(identity, payload) {
      const terminal = requireTerminal(identity, payload.ptyId, true);
      try {
        const success = await kiloClient.deletePty(payload.ptyId, terminal.directory);
        if (success && terminals.get(payload.ptyId) === terminal) {
          const bridge = bridges.get(payload.ptyId);
          if (bridge) closeBridge(bridge, 1000, 'PTY session ended');
          terminals.delete(payload.ptyId);
          const operation = operations.get(terminal.operationId);
          if (operation && sameSession(operation, terminal)) {
            operations.delete(terminal.operationId);
          }
        }
        return { success };
      } catch (error) {
        throw safeKiloFailure(error, 'Terminal closure failed');
      }
    },

    async connect(identity, payload) {
      const terminal = requireTerminal(identity, payload.ptyId);
      if (terminal.ownerId !== undefined && terminal.ownerId !== payload.ownerId) {
        throw new ControlTerminalRuntimeError('unauthorized', 'Terminal owner mismatch', false);
      }

      const current = bridges.get(payload.ptyId);
      if (current?.bridgeGeneration === payload.bridgeGeneration) {
        if (current.ownerId !== payload.ownerId || !current.connection) {
          throw new ControlTerminalRuntimeError(
            'unauthorized',
            'Terminal connection ownership mismatch',
            false
          );
        }
        return current.connection;
      }
      if (current) closeBridge(current, 4000, 'Terminal connection replaced');

      terminal.ownerId = payload.ownerId;
      const reverseUrl = new URL(controlOrigin);
      reverseUrl.pathname = `/sandbox-terminal/${encodeURIComponent(payload.ownerId)}/${encodeURIComponent(identity.sessionId)}/${encodeURIComponent(payload.ptyId)}`;
      reverseUrl.search = '';
      reverseUrl.hash = '';

      let reverse: WebSocket;
      try {
        const WebSocketImpl = WebSocket as AuthenticatedWebSocketConstructor;
        reverse = new WebSocketImpl(reverseUrl.toString(), {
          headers: { Authorization: `Bearer ${payload.capability}` },
        });
      } catch {
        throw new ControlTerminalRuntimeError('not_ready', 'Terminal transport failed', true);
      }
      reverse.binaryType = 'arraybuffer';

      const bridge: TerminalBridge = {
        terminal,
        ownerId: payload.ownerId,
        bridgeGeneration: payload.bridgeGeneration,
        reverse,
        closing: false,
      };
      bridges.set(payload.ptyId, bridge);
      reverse.onmessage = event => forwardMessage(bridge, bridge.local, event.data);
      reverse.onerror = () => {
        if (isCurrentBridge(bridge)) closeBridge(bridge, 1011, 'Terminal transport failed');
      };
      reverse.onclose = event => {
        if (!isCurrentBridge(bridge)) return;
        if (event.code === 1000 && event.reason === 'PTY session ended') {
          terminal.state = 'ended';
        }
        closeBridge(bridge, 1000, 'Terminal connection closed');
      };
      const connection = establishBridge(bridge);
      bridge.connection = connection;
      return connection;
    },

    shutdown() {
      if (shutDown) return;
      shutDown = true;
      for (const bridge of bridges.values()) {
        closeBridge(bridge, 1000, 'PTY session ended');
      }
      for (const attached of attachedSessions.values()) {
        forgetAttachedRoot(attached.kiloSessionId, attached.directory);
      }
      bridges.clear();
      terminals.clear();
      operations.clear();
      attachedSessions.clear();
    },
  };
}
