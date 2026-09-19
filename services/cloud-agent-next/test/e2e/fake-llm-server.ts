/**
 * Fake LLM for cloud-agent E2E harness — local Node `http` adapter.
 *
 * All deterministic behaviour lives in `fake-llm-core.ts`, shared with the
 * deployed Worker adapter (`fake-llm-worker.ts`). This module owns only the
 * local socket lifecycle and the `/test/*` admin credential.
 *
 * Preferred path: local Next.js routes `fake-deterministic` here while
 * `KILO_OPENROUTER_BASE` stays on the real gateway. Masquerade routes
 * (`/api/openrouter/{models,models/validate,chat/completions}`) still work
 * if something points at this service directly.
 *
 * The fake binds `0.0.0.0` by default, and `dev/local/services.ts` passes its
 * resolved port to `dev/local/scripts/start-public-tunnels.ts`, which can
 * publish it publicly. Every `/test/*` route therefore requires the admin
 * bearer from `resolveFakeAdminToken()`; the development default is insecure
 * and the tunnel refuses to publish it.
 *
 * See `README.md` in this directory for the local harness protocol.
 * See also `callback-server.ts` — same node:http + ephemeral-port lifecycle
 * handle pattern.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { resolveFakeAdminToken } from './fake-llm-admin.js';
import {
  createFakeLlmState,
  handleFakeLlmRequest,
  type FakeLlmEmit,
  type FakeLlmRequest,
} from './fake-llm-core.js';

// Pure helpers stay importable from here so existing importers are untouched.
export {
  buildRealisticReasoning,
  buildSeedFixture,
  extractLastUserMessageText,
  extractMultipartField,
  isToolError,
  MAX_FILE_SEED_BYTES,
  MAX_FILE_SEED_NONCE_LENGTH,
  MAX_REALISTIC_CHARS,
  MAX_REALISTIC_PIECES,
  MAX_TOOL_STREAM_BYTES,
  normalizeToolResult,
  parseDirective,
  parseFileDirective,
  scenarioRegistry,
  splitRealisticContent,
  stripKiloPromptWrapping,
  toolCallId,
} from './fake-llm-core.js';
export type {
  Directive,
  FakeScenarioStatus,
  FileDirective,
  FileDirectiveParse,
  ScenarioContext,
  ScenarioHandler,
} from './fake-llm-core.js';

export type FakeLlmServerHandle = {
  /** Base URL without trailing slash, e.g. `http://0.0.0.0:18811`. */
  url: string;
  port: number;
  /** Admin bearer this server expects on every `/test/*` route. */
  adminToken: string;
  /** `fetch` against this server with the resolved admin bearer attached. */
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
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

function toFakeRequest(req: IncomingMessage): FakeLlmRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    headers,
    readText: () => readBody(req),
  };
}

/**
 * Node emit. Mirrors the original `ServerResponse` write semantics:
 * SSE headers on first write, JSON for non-streamed bodies, and a bodyless
 * `writeHead(status); end()` for `empty`.
 */
function createNodeEmit(res: ServerResponse): FakeLlmEmit {
  let started = false;
  let ended = false;
  let closed = false;

  const start = (): void => {
    if (started || ended) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Disable Node's default socket timeout so `hang`/`gate` don't 5-minute
    // themselves off the air.
    res.socket?.setTimeout(0);
    res.flushHeaders();
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    if (!res.writableEnded) res.end();
  };

  const write = (text: string): void => {
    if (ended) return;
    res.write(text);
  };

  return {
    start,
    sse(chunk) {
      start();
      write(`data: ${JSON.stringify(chunk)}\n\n`);
    },
    done() {
      start();
      write('data: [DONE]\n\n');
    },
    json(status, body) {
      if (started) {
        // Stream already started — best-effort: end it.
        end();
        return;
      }
      if (ended) return;
      ended = true;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    empty(status) {
      if (started) {
        end();
        return;
      }
      if (ended) return;
      ended = true;
      res.writeHead(status);
      res.end();
    },
    fail(error) {
      console.error('[fake-llm] adapter error:', error);
      try {
        if (!started) {
          if (ended) return;
          ended = true;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'internal error', code: 500, type: 'server_error' },
            })
          );
          return;
        }
        end();
      } catch {
        // The adapter must never throw out of a failure path.
      }
    },
    end,
    isStarted() {
      return started;
    },
    onClose(listener) {
      if (closed) {
        listener();
        return;
      }
      res.on('close', () => {
        closed = true;
        listener();
      });
    },
  };
}

export async function startFakeLlmServer(opts?: {
  host?: string;
  port?: number;
}): Promise<FakeLlmServerHandle> {
  const host = opts?.host ?? '0.0.0.0';
  const requestedPort = opts?.port ?? 0;
  const adminToken = resolveFakeAdminToken();
  const state = createFakeLlmState();

  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const emit = createNodeEmit(res);
    // Node streams chunks as they are written, so the callback must not await
    // the handler; the core owns all failure paths (it never rejects).
    void handleFakeLlmRequest(toFakeRequest(req), emit, state, { adminToken }).catch(error => {
      emit.fail(error);
    });
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}`;

  function adminFetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${adminToken}`);
    return fetch(`${url}${path.startsWith('/') ? path : `/${path}`}`, { ...init, headers });
  }

  async function close(): Promise<void> {
    // Release any pending gates so they don't hold the process open.
    for (const waiters of state.gates.values()) {
      for (const waiter of waiters) {
        waiter.cleanup();
        waiter.emit.end();
      }
    }
    state.gates.clear();
    state.releasedGateFollowups.clear();
    state.scenarios.clear();
    // End any in-flight hang responses.
    for (const emit of state.liveResponses) emit.end();
    state.liveResponses.clear();
    // Force-destroy open sockets so server.close() can resolve promptly.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  return { url, port, adminToken, adminFetch, close };
}

// ---------------------------------------------------------------------------
// CLI entry — `tsx fake-llm-server.ts` started by the dev service launcher.
// ---------------------------------------------------------------------------

const isMain = (() => {
  // import.meta.url → file:// path; process.argv[1] → executed script path
  try {
    const argvPath = process.argv[1];
    if (!argvPath) return false;
    const scriptUrl = new URL(`file://${argvPath}`).href;
    return scriptUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? '8811', 10);
  startFakeLlmServer({ port, host: '0.0.0.0' })
    .then(handle => {
      // Never log the admin token itself.
      console.log(`[fake-llm] listening on ${handle.url}`);
      const shutdown = async (signal: string): Promise<void> => {
        console.log(`[fake-llm] received ${signal}, shutting down`);
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => {
        void shutdown('SIGINT');
      });
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
      });
    })
    .catch(err => {
      console.error('[fake-llm] failed to start:', err);
      process.exit(1);
    });
}
