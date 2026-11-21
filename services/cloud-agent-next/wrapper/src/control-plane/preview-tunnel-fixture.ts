import {
  decodeWrapperTunnelFrame,
  encodePreviewTunnelFrame,
  type PreviewTunnelFrame,
} from '../../../src/shared/preview-tunnel-protocol.js';

/**
 * Test-only: a fake Worker end of the preview tunnel. It plays the
 * `PreviewTunnel` Durable Object with the real codec and records what the
 * wrapper sends.
 */

type Waiter = {
  match: (frame: PreviewTunnelFrame) => boolean;
  resolve: (f: PreviewTunnelFrame) => void;
};

export type FakeTunnelWorker = {
  url: string;
  authorizations: string[];
  /** Protocol pings that reached the Worker end. */
  pings(): number;
  connections(): number;
  waitForConnection(count?: number): Promise<void>;
  send(frame: PreviewTunnelFrame): void;
  sendRaw(data: string | Uint8Array): void;
  close(code: number): void;
  take<T extends PreviewTunnelFrame['type']>(
    type: T,
    stream?: number,
    timeoutMs?: number
  ): Promise<Extract<PreviewTunnelFrame, { type: T }>>;
  /** The next frame of any type for `stream`. */
  next(stream: number, timeoutMs?: number): Promise<PreviewTunnelFrame>;
  /** Frames received and not yet taken. */
  pending(): PreviewTunnelFrame[];
  /** The close code of connection `index` (0-based), or null while it is open. */
  closeCode(index?: number): number | null;
  waitForClose(index?: number, timeoutMs?: number): Promise<number | null>;
  stop(): Promise<void>;
};

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(5);
  }
  return true;
}

export function startFakeTunnelWorker(): FakeTunnelWorker {
  const sockets: Bun.ServerWebSocket<undefined>[] = [];
  const closeCodes: Array<number | null> = [];
  const queued: PreviewTunnelFrame[] = [];
  const waiters: Waiter[] = [];
  const authorizations: string[] = [];
  let pings = 0;

  const receive = (frame: PreviewTunnelFrame): void => {
    const index = waiters.findIndex(waiter => waiter.match(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(frame);
      return;
    }
    queued.push(frame);
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, srv) {
      authorizations.push(request.headers.get('authorization') ?? '');
      return srv.upgrade(request) ? undefined : new Response('upgrade', { status: 426 });
    },
    websocket: {
      open(ws) {
        // Frames of an older tunnel are no longer of interest.
        queued.length = 0;
        sockets.push(ws);
        closeCodes.push(null);
      },
      message(ws, message) {
        if (ws !== sockets.at(-1)) return;
        if (typeof message === 'string') throw new Error('The wrapper sent a text message');
        const decoded = decodeWrapperTunnelFrame(message);
        if (!decoded.ok)
          throw new Error(`The wrapper sent a bad frame: ${decoded.violation.reason}`);
        receive(decoded.frame);
      },
      ping() {
        pings += 1;
      },
      close(ws, code) {
        closeCodes[sockets.indexOf(ws)] = code;
      },
    },
  });
  const takeMatching = (
    match: (frame: PreviewTunnelFrame) => boolean,
    what: string,
    timeoutMs: number
  ): Promise<PreviewTunnelFrame> => {
    const index = queued.findIndex(match);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: frame => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`No ${what}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const current = (): Bun.ServerWebSocket<undefined> => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('No tunnel is connected');
    return socket;
  };

  return {
    url: `ws://127.0.0.1:${server.port}/sandbox-preview-tunnel/sbx_1`,
    authorizations,
    pings: () => pings,
    connections: () => sockets.length,
    async waitForConnection(count = 1) {
      if (!(await until(() => sockets.length >= count, 2_000))) {
        throw new Error('The wrapper did not connect');
      }
    },
    send(frame) {
      current().send(encodePreviewTunnelFrame(frame));
    },
    sendRaw(data) {
      current().send(data);
    },
    close(code) {
      current().close(code, 'test');
    },
    take(type, stream, timeoutMs = 2_000) {
      const match = (frame: PreviewTunnelFrame): boolean =>
        frame.type === type && (stream === undefined || frame.stream === stream);
      return takeMatching(match, `${type} frame for stream ${stream ?? 'any'}`, timeoutMs) as never;
    },
    next(stream, timeoutMs = 2_000) {
      return takeMatching(frame => frame.stream === stream, `frame for ${stream}`, timeoutMs);
    },
    pending: () => [...queued],
    closeCode: (index = sockets.length - 1) => closeCodes[index] ?? null,
    async waitForClose(index = sockets.length - 1, timeoutMs = 2_000) {
      await until(() => (closeCodes[index] ?? null) !== null, timeoutMs);
      return closeCodes[index] ?? null;
    },
    async stop() {
      // Bun 1.3 does not settle a forced stop after the server closed a WebSocket.
      void server.stop(true);
    },
  };
}
