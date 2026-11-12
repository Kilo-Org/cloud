function buildPtyUpstreamUrl(workspacePath: string, serverUrl: string, ptyId: string): string {
  const upstream = new URL(`/pty/${encodeURIComponent(ptyId)}/connect`, serverUrl);
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  upstream.searchParams.set('directory', workspacePath);
  return upstream.toString();
}

export type WrapperWebSocketData = {
  ptyId?: string;
};

type PtyClientClose = {
  code: number;
  reason: string;
};

function isForwardableCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) && code >= 1000 && code <= 4999 && ![1005, 1006, 1015].includes(code)
  );
}

export function resolvePtyClientClose(event: { code: number; reason: string }): PtyClientClose {
  if (event.code === 1000) {
    return { code: 1000, reason: 'PTY session ended' };
  }

  if (isForwardableCloseCode(event.code)) {
    return { code: event.code, reason: event.reason || 'PTY upstream closed' };
  }

  return { code: 1011, reason: event.reason || 'PTY upstream closed' };
}

export function createTerminalWebSocketHandlers(
  getTarget: () => { workspacePath: string; serverUrl: string }
) {
  const ptyUpstreams = new WeakMap<
    object,
    { socket: WebSocket; pending: (string | ArrayBuffer)[]; queuedBytes: number }
  >();

  return {
    open(ws: Bun.ServerWebSocket<WrapperWebSocketData>) {
      const ptyId = ws.data.ptyId;
      if (!ptyId) {
        ws.close(1011, 'Missing PTY');
        return;
      }

      const { workspacePath, serverUrl } = getTarget();
      const upstream = new WebSocket(buildPtyUpstreamUrl(workspacePath, serverUrl, ptyId));
      upstream.binaryType = 'arraybuffer';
      const relay = { socket: upstream, pending: [] as (string | ArrayBuffer)[], queuedBytes: 0 };
      ptyUpstreams.set(ws, relay);
      upstream.onopen = () => {
        if (ptyUpstreams.get(ws) !== relay) return;
        for (const message of relay.pending) upstream.send(message);
        relay.pending = [];
        relay.queuedBytes = 0;
      };

      upstream.onmessage = event => {
        try {
          ws.send(event.data instanceof ArrayBuffer ? event.data : String(event.data));
        } catch {
          // Client disconnected.
        }
      };
      upstream.onclose = event => {
        const close = resolvePtyClientClose({ code: event.code, reason: event.reason });
        try {
          ws.close(close.code, close.reason);
        } catch {
          // Already closed.
        }
      };
      upstream.onerror = () => {
        try {
          ws.close(1011, 'PTY upstream error');
        } catch {
          // Already closed.
        }
      };
    },
    message(
      ws: Bun.ServerWebSocket<WrapperWebSocketData>,
      message: string | ArrayBuffer | Uint8Array
    ) {
      const relay = ptyUpstreams.get(ws);
      if (!relay) return;
      let data: string | ArrayBuffer;
      if (typeof message === 'string' || message instanceof ArrayBuffer) data = message;
      else {
        const copy = new Uint8Array(message.byteLength);
        copy.set(message);
        data = copy.buffer;
      }
      if (relay.socket.readyState === WebSocket.OPEN) relay.socket.send(data);
      else if (relay.socket.readyState === WebSocket.CONNECTING) {
        relay.queuedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        if (relay.queuedBytes > 1024 * 1024 || relay.pending.length >= 128) {
          ptyUpstreams.delete(ws);
          relay.socket.close();
          ws.close(1009, 'Terminal input queue exceeded');
          return;
        }
        relay.pending.push(data);
      }
    },
    close(ws: Bun.ServerWebSocket<WrapperWebSocketData>) {
      const relay = ptyUpstreams.get(ws);
      if (relay) {
        ptyUpstreams.delete(ws);
        try {
          relay.socket.close();
        } catch {
          // Already closed.
        }
      }
    },
  };
}
