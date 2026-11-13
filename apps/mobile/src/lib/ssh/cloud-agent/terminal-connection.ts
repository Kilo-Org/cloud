import {
  classifyTerminalClose,
  classifyTerminalFailure,
  isPtyControlFrame,
  parseTerminalFrame,
  resolveTerminalWsUrl,
  type TerminalFrame,
  terminalReconnectDelayMs,
} from './terminal-protocol';

/**
 * The terminal's own state. It is what the strip above the terminal says, and
 * each state exists because a socket and a pty can end in different ways:
 * `stopped` is a sleeping sandbox (retryable), `failed` is a refusal this
 * screen cannot retry, `exited` is the shell ending on its own.
 */
export type TerminalFailureReason = 'not-found' | 'forbidden' | 'unavailable' | 'disconnected';

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'stopped' }
  | { kind: 'exited' }
  | { kind: 'failed'; reason: TerminalFailureReason };

type TerminalSize = { cols: number; rows: number };

/** The socket this module drives; `openTerminalSocket` is the only production one. */
export type TerminalSocket = {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (frame: TerminalFrame) => void): void;
  onError(listener: () => void): void;
  onClose(listener: (event: { code: number; reason: string }) => void): void;
};

/**
 * Wraps the platform WebSocket so the connection sees only the events it uses.
 * The wrapper is also where binary frames are asked for, which a pty stream
 * needs and the default `blob` type would turn into an unreadable payload.
 */
function openTerminalSocket(url: string): TerminalSocket {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  return {
    send: bytes => {
      socket.send(bytes);
    },
    close: (code, reason) => {
      socket.close(code, reason);
    },
    onOpen: listener => {
      socket.addEventListener('open', () => {
        listener();
      });
    },
    onMessage: listener => {
      socket.addEventListener('message', event => {
        const frame = parseTerminalFrame(event.data);
        if (frame !== null) {
          listener(frame);
        }
      });
    },
    onError: listener => {
      socket.addEventListener('error', () => {
        listener();
      });
    },
    onClose: listener => {
      socket.addEventListener('close', event => {
        listener({ code: event.code, reason: event.reason });
      });
    },
  };
}

/** The control-plane calls a terminal is made of, scoped by the caller. */
export type TerminalOperations = {
  create: (size: { cols?: number; rows?: number }) => Promise<{ ptyId: string; wsUrl: string }>;
  refreshTicket: (input: { ptyId: string }) => Promise<{ wsUrl: string }>;
  resize: (input: { ptyId: string; cols: number; rows: number }) => void;
  close: (input: { ptyId: string }) => void;
};

export type TerminalConnectionOptions = {
  /** The Worker base the ticket's path is resolved against. */
  baseUrl: string;
  operations: TerminalOperations;
  socketFor?: (url: string) => TerminalSocket;
  onState: (state: TerminalState) => void;
  /** Bytes the pty printed. */
  onData: (bytes: Uint8Array) => void;
  /** The pty ended; the terminal view shows its last output beside this. */
  onClosed: (notice: { exitStatus: number | null; error: string | null }) => void;
};

/**
 * One terminal over one pty.
 *
 * The pty outlives the socket, so a lost socket is retried with a fresh ticket
 * for the same pty; a pty that is gone (a sleeping sandbox) takes the terminal
 * back to `stopped`, where the screen offers a retry that creates a new pty.
 * Every asynchronous step re-checks `stoppedBy` because the screen can unmount,
 * or the sandbox can sleep, while a create is still in flight.
 */
export class TerminalConnection {
  private readonly options: TerminalConnectionOptions;
  private readonly socketFor: (url: string) => TerminalSocket;

  private socket: TerminalSocket | null = null;
  private ptyId: string | null = null;
  private size: TerminalSize | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stoppedBy: 'unmount' | 'sleep' | null = null;
  private socketOpen = false;

  constructor(options: TerminalConnectionOptions) {
    this.options = options;
    this.socketFor = options.socketFor ?? openTerminalSocket;
  }

  start(): void {
    this.attempt = 0;
    void this.createAndConnect();
  }

  /** The screen's Retry, and its resume after a sleeping sandbox. */
  retry(): void {
    this.clearReconnect();
    this.attempt = 0;
    this.stoppedBy = null;
    if (this.ptyId === null) {
      void this.createAndConnect();
      return;
    }
    this.publish({ kind: 'reconnecting', attempt: 0 });
    void this.connectOrCreate();
  }

  /** Bytes from the terminal view; a closed socket drops them, as a closed pty would. */
  send(bytes: Uint8Array): void {
    if (!this.socketOpen) {
      return;
    }
    this.socket?.send(bytes);
  }

  /** The view reported a new geometry; a pty that exists follows it. */
  setSize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.resizePty();
  }

  stop(): void {
    if (this.stoppedBy === 'unmount') {
      return;
    }
    this.stoppedBy = 'unmount';
    this.teardown();
  }

  private publish(state: TerminalState): void {
    if (this.stoppedBy === null) {
      this.options.onState(state);
    }
  }

  private async connectOrCreate(): Promise<void> {
    const ptyId = this.ptyId;
    if (ptyId === null) {
      await this.createAndConnect();
      return;
    }

    try {
      const result = await this.options.operations.refreshTicket({ ptyId });
      this.connectSocket(result.wsUrl);
    } catch (error) {
      this.applyFailure(error);
    }
  }

  private async createAndConnect(): Promise<void> {
    this.publish({ kind: 'connecting' });
    try {
      const result = await this.options.operations.create({ ...this.size });
      if (this.stoppedBy !== null) {
        this.options.operations.close({ ptyId: result.ptyId });
        return;
      }
      this.ptyId = result.ptyId;
      this.connectSocket(result.wsUrl);
    } catch (error) {
      this.applyFailure(error);
    }
  }

  private connectSocket(wsUrl: string): void {
    const url = this.resolveUrl(wsUrl);
    if (url === null) {
      return;
    }

    this.socketOpen = false;
    const socket = this.socketFor(url);
    this.socket = socket;

    socket.onOpen(() => {
      if (this.socket !== socket) {
        return;
      }
      this.socketOpen = true;
      this.attempt = 0;
      this.publish({ kind: 'connected' });
      this.resizePty();
    });

    socket.onMessage(frame => {
      if (this.socket !== socket || isPtyControlFrame(frame)) {
        return;
      }
      this.options.onData(
        frame.kind === 'text' ? new TextEncoder().encode(frame.text) : new Uint8Array(frame.data)
      );
    });

    socket.onError(() => {
      if (this.socket === socket && !this.socketOpen) {
        this.publish({ kind: 'reconnecting', attempt: this.attempt });
      }
    });

    socket.onClose(event => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.socketOpen = false;
      if (this.stoppedBy !== null) {
        return;
      }
      this.handleSocketClose(event);
    });
  }

  private resolveUrl(wsUrl: string): string | null {
    try {
      return resolveTerminalWsUrl(wsUrl, this.options.baseUrl);
    } catch (error) {
      this.applyFailure(error);
      return null;
    }
  }

  private handleSocketClose(event: { code: number; reason: string }): void {
    const outcome = classifyTerminalClose(event);
    if (outcome.kind === 'retry') {
      this.scheduleReconnect();
      return;
    }

    const ptyId = this.ptyId;
    this.ptyId = null;
    if (ptyId !== null) {
      this.options.operations.close({ ptyId });
    }

    if (outcome.kind === 'exited') {
      this.publish({ kind: 'exited' });
      this.options.onClosed({ exitStatus: 0, error: null });
      return;
    }

    this.publish({ kind: 'failed', reason: 'disconnected' });
    this.options.onClosed({ exitStatus: null, error: null });
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = terminalReconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.publish({ kind: 'reconnecting', attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOrCreate();
    }, delay);
  }

  private applyFailure(error: unknown): void {
    if (this.stoppedBy !== null) {
      return;
    }
    const failure = classifyTerminalFailure(error);
    if (failure.kind === 'retry') {
      this.scheduleReconnect();
      return;
    }
    if (failure.kind === 'stopped') {
      this.enterSleeping();
      return;
    }
    this.ptyId = null;
    this.publish({ kind: 'failed', reason: failure.reason });
  }

  private enterSleeping(): void {
    this.clearReconnect();
    this.attempt = 0;
    this.ptyId = null;
    this.closeSocket('Terminal sleeping');
    this.publish({ kind: 'stopped' });
  }

  private resizePty(): void {
    const ptyId = this.ptyId;
    const size = this.size;
    if (ptyId === null || size === null) {
      return;
    }
    this.options.operations.resize({ ptyId, cols: size.cols, rows: size.rows });
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    socket?.close(1000, reason);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardown(): void {
    this.clearReconnect();
    this.closeSocket('Terminal closed');
    const ptyId = this.ptyId;
    this.ptyId = null;
    if (ptyId !== null) {
      this.options.operations.close({ ptyId });
    }
    this.attempt = 0;
  }
}
