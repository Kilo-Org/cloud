/**
 * Local HTTP sink for exercising the cloud-agent-next callback delivery path.
 *
 * The cloud-agent Worker delivers callbacks by making an outbound `fetch()`
 * from inside `workerd` (see `src/callbacks/delivery.ts:29`). `workerd` runs
 * as a host process under `wrangler dev`, so it can reach `127.0.0.1:<port>`
 * on the same host directly — no `host.docker.internal` / tunnel needed.
 *
 * The driver spins this server up, registers `{ url, headers? }` as the
 * session's `callbackTarget`, and later asserts on the received payloads.
 *
 * Every POST is recorded with headers + parsed JSON body. `waitFor()` lets
 * tests await a callback matching a predicate (e.g. by `sessionId` or
 * `executionId`) without polling.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type CallbackRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body if Content-Type was application/json, else the raw string. */
  body: unknown;
  receivedAt: number;
};

export type CallbackServerHandle = {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:51234`. */
  url: string;
  /** The full callback URL including `/callback` suffix — register this in `callbackTarget.url`. */
  callbackUrl: string;
  port: number;
  received: CallbackRecord[];
  /**
   * Resolve the first callback matching `predicate`, or null when `timeoutMs`
   * elapses. Matches history before new arrivals so late connections still win.
   */
  waitFor: (
    predicate: (record: CallbackRecord) => boolean,
    timeoutMs: number
  ) => Promise<CallbackRecord | null>;
  close: () => Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headersToObject(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

export async function startCallbackServer(opts?: { host?: string }): Promise<CallbackServerHandle> {
  const host = opts?.host ?? '127.0.0.1';
  const received: CallbackRecord[] = [];
  type Listener = {
    predicate: (record: CallbackRecord) => boolean;
    resolve: (record: CallbackRecord | null) => void;
  };
  const listeners: Listener[] = [];

  const server: Server = createServer((req, res) => {
    readBody(req)
      .then(raw => {
        const contentType = req.headers['content-type'] ?? '';
        let body: unknown = raw;
        if (contentType.includes('application/json') && raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            // Keep raw body on parse failure — the driver may still want to inspect.
          }
        }
        const record: CallbackRecord = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: headersToObject(req.headers),
          body,
          receivedAt: Date.now(),
        };
        received.push(record);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');

        for (let i = listeners.length - 1; i >= 0; i--) {
          const listener = listeners[i];
          if (listener && listener.predicate(record)) {
            listener.resolve(record);
            listeners.splice(i, 1);
          }
        }
      })
      .catch(err => {
        console.error('callback-server read error:', err);
        res.writeHead(500);
        res.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}`;
  const callbackUrl = `${url}/callback`;

  function waitFor(
    predicate: (record: CallbackRecord) => boolean,
    timeoutMs: number
  ): Promise<CallbackRecord | null> {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const idx = listeners.findIndex(l => l.resolve === resolveOnce);
        if (idx >= 0) listeners.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      function resolveOnce(record: CallbackRecord | null): void {
        clearTimeout(timer);
        resolve(record);
      }
      listeners.push({ predicate, resolve: resolveOnce });
    });
  }

  function close(): Promise<void> {
    for (const listener of listeners.splice(0)) {
      listener.resolve(null);
    }
    return new Promise(resolve => server.close(() => resolve()));
  }

  return { url, callbackUrl, port, received, waitFor, close };
}
