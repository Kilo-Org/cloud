import type { FetchLike } from '../../core/fetch.js';

/**
 * The adapter for a runtime that has a WHATWG `fetch`: Node, a browser, a
 * Cloudflare Worker, React Native. It is what every caller was writing by hand.
 *
 * `core/fetch.ts` explains why the core declares its own `fetch` shape and
 * never calls a runtime's. That reason holds for the core and not for a plugin,
 * which is what this is. Nothing here names a platform: `fetch`, `TextDecoder`
 * and the streamed body are web globals, and a runtime that lacks them wants an
 * adapter of its own anyway.
 *
 * The types are declared below rather than pulled from the DOM library, because
 * `tsconfig.json` sets `"lib": ["esnext"]` and `"types": []` and that is what
 * keeps the package honest about what it depends on. Only the members used are
 * named, which is also what makes the signal fit: the core's `AbortLike` is
 * structurally what `signal` below asks for, so nothing is cast.
 */

/** Only what this file reads. A runtime's own types are wider and compatible. */
interface Body {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<Uint8Array>;
}

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
  readonly body: Body | null;
}

interface Sent {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: unknown;
}

interface Decoder {
  readonly decode: (chunk: Uint8Array, options: { readonly stream: boolean }) => string;
}

declare const fetch: (url: string, request: Sent) => Promise<Reply>;
declare const TextDecoder: new () => Decoder;

const decoded = async function* decoded(body: Body): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield decoder.decode(chunk, { stream: true });
  }
};

const webFetch: FetchLike = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    /* The runtime stops the call when the caller stops listening. Dropping this
       would leave a cancelled call still running, and still being charged for,
       on the provider. */
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  /* Named once, so the narrowing holds inside the closure below. */
  const { body } = response;
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    ...(body === null ? {} : { stream: () => decoded(body) }),
  };
};

export { webFetch };
