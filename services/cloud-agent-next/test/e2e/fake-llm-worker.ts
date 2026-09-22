/**
 * Deployed fake LLM: a Cloudflare Worker backed by one Durable Object.
 *
 * The Worker entry owns the model-route auth boundary (a Kilo JWT, verified
 * against the `NEXTAUTH_SECRET` Secrets Store binding) and then forwards to a
 * single `FakeLlmState` Durable Object. The DO executes the same
 * runtime-neutral core as the local Node adapter, so the deterministic
 * directives, counters and gates behave identically; only the counters and the
 * released-gate follow-ups are durable, because a Worker can run on any isolate
 * and be evicted.
 *
 * Every `/test/*` route is guarded inside the core with the separate admin
 * bearer (`FAKE_LLM_ADMIN_TOKEN`), identically in both runtimes.
 *
 * This is a test-only Worker: `test/e2e/wrangler.fake-llm.jsonc`. It is never
 * the production config.
 */

import { DurableObject } from 'cloudflare:workers';

import {
  FAKE_LLM_STATE_STORAGE_KEY,
  HEALTH_BODY,
  createFakeLlmState,
  handleFakeLlmRequest,
  hydrateFakeLlmState,
  serializeFakeLlmState,
  type FakeLlmEmit,
  type FakeLlmRequest,
  type FakeLlmState as FakeLlmCoreState,
  type PersistedFakeLlmState,
} from './fake-llm-core.js';
import { verifyModelRouteBearer, type NextAuthSecretBinding } from './fake-llm-model-auth.js';

export type FakeLlmWorkerEnv = {
  FAKE_LLM: DurableObjectNamespace<FakeLlmState>;
  /** Secrets Store binding in the deployed config; a plain string in tests. */
  NEXTAUTH_SECRET?: NextAuthSecretBinding;
  /** Admin bearer for `/test/*`. Absent means every `/test/*` request 401s. */
  FAKE_LLM_ADMIN_TOKEN?: string;
};

function modelAuthError(status: number, message: string): Response {
  return Response.json(
    { error: { message, code: status, type: status === 500 ? 'server_error' : 'unauthorized' } },
    { status }
  );
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
};

const textEncoder = new TextEncoder();

/** Returned when the handler completed without ever shaping a response. */
export function closedInternalErrorResponse(): Response {
  return new Response(null, { status: 500 });
}

export type WorkerEmit = FakeLlmEmit & {
  /** Resolves on the first `start`/`sse`/`json`/`empty`. */
  readonly shaped: Promise<void>;
  /** True once a response shape exists (JSON, empty, or SSE). */
  shapedWon(): boolean;
  toResponse(): Response;
};

/**
 * Response sink for the DO fetch path.
 *
 * Response readiness is separate from handler completion: `shaped` resolves on
 * the first emitted byte, so a `__fake__:slow:` stream that writes its first
 * chunks before awaiting its delays is returned immediately rather than
 * buffered. `fetch` waits on `shaped`, never on the handler.
 *
 * Every terminal transition funnels through one idempotent `settle`.
 */
export function createWorkerEmit(request: Request): WorkerEmit {
  let stream: ReadableStream<Uint8Array> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let started = false;
  let settled = false;
  let streamTerminated = false;
  let kind: 'sse' | 'json' | 'empty' | null = null;
  let status = 200;
  let jsonBody: unknown;
  const closeListeners: Array<() => void> = [];
  let closeFired = false;
  let shapedResolved = false;
  let resolveShaped: () => void = () => {};
  const shaped = new Promise<void>(resolve => {
    resolveShaped = resolve;
  });

  const fireClose = (): void => {
    if (closeFired) return;
    closeFired = true;
    for (const listener of closeListeners.splice(0)) {
      try {
        listener();
      } catch {
        // A close listener must never affect the response.
      }
    }
  };

  const ensureStream = (): ReadableStream<Uint8Array> => {
    if (stream) return stream;
    stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel() {
        // Client disconnect: the analogue of Node's socket close, and a
        // terminal transition, so it funnels through the one idempotent settle.
        fireClose();
        settle('sse');
      },
    });
    return stream;
  };

  const markShaped = (): void => {
    if (shapedResolved) return;
    shapedResolved = true;
    resolveShaped();
  };

  const terminateStream = (error?: unknown): void => {
    if (streamTerminated || !controller) return;
    streamTerminated = true;
    try {
      if (error === undefined) controller.close();
      else controller.error(error);
    } catch {
      // Already closed by the client.
    }
  };

  const settle = (nextKind: 'sse' | 'json' | 'empty', error?: unknown): void => {
    if (settled) return;
    settled = true;
    kind = nextKind;
    markShaped();
    if (nextKind === 'sse') terminateStream(error);
    else terminateStream();
  };

  const write = (text: string): void => {
    if (streamTerminated || !controller) return;
    try {
      controller.enqueue(textEncoder.encode(text));
    } catch {
      // Client gone; nothing else to do.
    }
  };

  const emit: WorkerEmit = {
    start() {
      if (started || settled) return;
      started = true;
      ensureStream();
      kind = 'sse';
      markShaped();
    },
    sse(chunk) {
      emit.start();
      write(`data: ${JSON.stringify(chunk)}\n\n`);
    },
    done() {
      emit.start();
      write('data: [DONE]\n\n');
    },
    json(nextStatus, body) {
      if (started) {
        emit.end();
        return;
      }
      if (settled) return;
      status = nextStatus;
      jsonBody = body;
      settle('json');
    },
    empty(nextStatus) {
      if (started) {
        emit.end();
        return;
      }
      if (settled) return;
      status = nextStatus;
      settle('empty');
    },
    fail(error) {
      console.error('[fake-llm] adapter error:', error);
      try {
        if (!started && !settled) {
          status = 500;
          jsonBody = { error: { message: 'internal error', code: 500, type: 'server_error' } };
          settle('json');
          return;
        }
        settle('sse', error instanceof Error ? error : new Error('fake-llm stream failed'));
        fireClose();
      } catch {
        // The adapter must never throw out of a failure path.
      }
    },
    end() {
      if (settled) return;
      if (!started) {
        started = true;
        ensureStream();
        kind = 'sse';
        markShaped();
      }
      settle('sse');
    },
    isStarted() {
      return started;
    },
    onClose(listener) {
      if (closeFired) {
        try {
          listener();
        } catch {
          // Ignore.
        }
        return;
      }
      closeListeners.push(listener);
    },
    get shaped() {
      return shaped;
    },
    shapedWon() {
      return kind !== null;
    },
    toResponse() {
      if (kind === 'json') return Response.json(jsonBody, { status });
      if (kind === 'empty') return new Response(null, { status });
      return new Response(ensureStream(), { status: 200, headers: SSE_HEADERS });
    },
  };

  if (request.signal.aborted) fireClose();
  else request.signal.addEventListener('abort', fireClose);

  return emit;
}

function toFakeRequest(request: Request): FakeLlmRequest {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    readText: () => request.text(),
  };
}

function logPersistError(error: unknown): void {
  console.error('[fake-llm] failed to persist state:', error);
}

export class FakeLlmState extends DurableObject<FakeLlmWorkerEnv> {
  private core: FakeLlmCoreState;

  constructor(ctx: DurableObjectState, env: FakeLlmWorkerEnv) {
    super(ctx, env);
    // Empty state until hydration completes; hydration only runs here, under
    // `blockConcurrencyWhile`, never across a stream or a request.
    this.core = createFakeLlmState();
    void ctx.blockConcurrencyWhile(async () => {
      const persisted = await ctx.storage.get<PersistedFakeLlmState>(FAKE_LLM_STATE_STORAGE_KEY);
      this.core = hydrateFakeLlmState(persisted);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const emit = createWorkerEmit(request);
    const handler = handleFakeLlmRequest(toFakeRequest(request), emit, this.core, {
      adminToken: this.env.FAKE_LLM_ADMIN_TOKEN,
    });
    // No unobserved rejections: the dispatcher never rejects, `persist` gets its
    // own handler, and `emit.fail` wraps its body.
    void handler.catch(error => emit.fail(error));
    // Persist on HANDLER completion, including a parked gate whose stream stays
    // open: gate registration has already returned, and release is a separate
    // request that persists again.
    void handler.then(() => this.persist()).catch(logPersistError);

    await Promise.race([emit.shaped, handler]);
    return emit.shapedWon() ? emit.toResponse() : closedInternalErrorResponse();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(FAKE_LLM_STATE_STORAGE_KEY, serializeFakeLlmState(this.core));
  }
}

export default {
  async fetch(request: Request, env: FakeLlmWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(HEALTH_BODY);
    }

    // The Worker entry owns the model-route bearer boundary: every request
    // outside the admin-guarded `/test/*` namespace must present a valid Kilo
    // JWT. `/health` is exempt above and `/test/*` is guarded inside the core
    // with the separate admin bearer, so no path list is duplicated here.
    // Unknown unauthenticated paths therefore fail closed with 401 instead of
    // reaching the core's 404; they still return 404 once a valid model token is
    // presented. The local Node server deliberately leaves its model routes open
    // for the Next.js gateway's static credential; only this Worker verifies.
    if (!url.pathname.startsWith('/test/')) {
      const auth = await verifyModelRouteBearer(
        request.headers.get('authorization') ?? undefined,
        env.NEXTAUTH_SECRET
      );
      if (!auth.ok) return modelAuthError(auth.status, auth.message);
    }

    return env.FAKE_LLM.get(env.FAKE_LLM.idFromName('fake-llm')).fetch(request);
  },
};
