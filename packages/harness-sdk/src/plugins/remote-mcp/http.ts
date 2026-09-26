import type { RemoteMcpServer } from './server.js';

/**
 * The runtime seam of the remote MCP plugin: the deadline, the request, and the
 * headers it carries.
 *
 * Everything here exists because the plugin runs where a platform's own types
 * are not available. `tsconfig.json` sets `"lib": ["esnext"]` and `"types": []`,
 * so the parts of the runtime this file uses are declared, exactly as
 * `plugins/fetch/web.ts` declares its own. The `fetch` is never read off a
 * global — it is handed in, so the same plugin runs in a browser, on Node, in a
 * Worker and in a mobile app.
 */

/**
 * The part of a runtime's `AbortSignal` this plugin uses.
 *
 * React Native's is `abort-controller`, which has neither
 * `AbortSignal.timeout` nor `AbortSignal.any`, so the deadline is built by hand
 * below. The two methods are optional because a runtime without them still
 * gets a bounded request; it simply cannot be cancelled early.
 */
interface RemoteMcpAbort {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

interface RemoteMcpAbortController {
  readonly signal: RemoteMcpAbort;
  abort(): void;
}

/**
 * The members of a request this plugin writes.
 *
 * A reply is never read here: the client library reads it. That is why the
 * reply type is the library's own and not something declared here.
 */
interface RemoteMcpRequest {
  readonly method?: string;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly signal?: RemoteMcpAbort | null;
}

declare const AbortController: new () => RemoteMcpAbortController;
declare const setTimeout: (handler: () => void, timeoutMs: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/** A runtime's `fetch`, as the caller hands it over. */
type RemoteMcpFetch = (url: string | URL, init?: RemoteMcpRequest) => Promise<Response>;

/**
 * The caller of that `fetch`.
 *
 * The whole object is passed to `bounded` rather than the method, because a
 * method taken off its receiver is unbound: the runtime would receive it with
 * no object behind it.
 */
interface RemoteMcpFetchHost {
  fetch(url: string | URL, init?: RemoteMcpRequest): Promise<Response>;
}

/** How long discovery may take when the caller names no deadline. */
const defaultTimeoutMs = 15_000;

/**
 * How long one call may take when the caller names no deadline. It must stay
 * above the 15 seconds a remote tool is waited on inline (`tools.ts`): the
 * session backgrounds a call at that point, and a deadline that ends at the
 * same moment would fail the call instead of letting it answer.
 */
const defaultCallTimeoutMs = 60_000;

/** One deadline, and the ways it ends. */
interface Deadline {
  readonly signal: RemoteMcpAbort;
  abort: () => void;
  /** Joins a signal to the deadline until `stop`. A signal joined twice is joined once. */
  link: (signal: RemoteMcpAbort) => void;
  stop: () => void;
}

/**
 * The deadline every request of one operation shares.
 *
 * `AbortSignal.timeout` and `AbortSignal.any` are not on React Native's
 * `AbortSignal`, so the timer and the joined signals are linked by hand. The
 * release clears the timer and takes every listener back off, so a finished
 * operation leaves nothing running and nothing listening.
 */
const makeDeadline = (timeoutMs: number, caller: RemoteMcpAbort | undefined): Deadline => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const abort = (): void => {
    controller.abort();
  };
  const linked = new Set<RemoteMcpAbort>();
  const link = (signal: RemoteMcpAbort): void => {
    if (linked.has(signal)) {
      return;
    }
    linked.add(signal);
    signal.addEventListener?.('abort', abort);
  };
  if (caller !== undefined) {
    link(caller);
  }
  return {
    signal: controller.signal,
    abort,
    link,
    stop: () => {
      clearTimeout(timer);
      for (const signal of linked) {
        signal.removeEventListener?.('abort', abort);
      }
      linked.clear();
    },
  };
};

/**
 * The `fetch` the transport is given: the caller's, under the deadline.
 *
 * The library's own signal is joined to the deadline, which is the signal the
 * request carries. That signal is how `close()` stops a stream that is still
 * open, and `fetch` resolves when the headers arrive, before the body is read.
 * So the link stays until the operation ends (`stop`), not until the request
 * resolves: removing it earlier would leave the server sending into nothing.
 */
const bounded =
  (host: RemoteMcpFetchHost, deadline: Deadline): RemoteMcpFetch =>
  async (url, init) => {
    const upstream = init?.signal;
    if (upstream !== undefined && upstream !== null) {
      deadline.link(upstream);
    }
    return host.fetch(url, { ...init, signal: deadline.signal });
  };

/**
 * What one request carries.
 *
 * The credential arrives already formatted, so the token itself is never a
 * value this file holds, compares or writes down: it is read from the accessor,
 * rendered into the header, and gone.
 */
const headersFor = (
  server: RemoteMcpServer,
  credential: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => ({ ...server.headers, ...credential });

export type { Deadline, RemoteMcpAbort, RemoteMcpFetch, RemoteMcpFetchHost, RemoteMcpRequest };
export { bounded, defaultCallTimeoutMs, defaultTimeoutMs, headersFor, makeDeadline };
