import { type FetchLike } from '@kilocode/harness-sdk';

/**
 * The one call the harness makes, as this app makes it.
 *
 * The package ships `webFetch`, and it reads a response body by iterating it.
 * React Native's body is a `ReadableStream` that iterates on Node and not
 * here, so this reads it the way the rest of the app reads a stream: with a
 * reader. The README calls this out as the case a runtime writes its own
 * adapter for.
 *
 * It is also where the feature header goes. The gateway attributes every
 * microdollar to the header's value, and the harness knows nothing about which
 * of Kilo's products is holding it.
 */

const FEATURE_HEADER = 'X-KILOCODE-FEATURE';

/** What the gateway files this surface's spending under. */
const FEATURE = 'mobile-chat';

/**
 * Yields the body as text, in the pieces it arrives in. The reader is released
 * whether the stream ended, failed, or the caller stopped listening: a lock
 * left behind holds the connection open for the life of the app.
 */
async function* decoded(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk after the previous one, which is the whole point
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export const chatFetch: FetchLike = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers, [FEATURE_HEADER]: FEATURE },
    body: request.body,
    // The runtime's own signal type. Dropping it would leave a stopped answer
    // still arriving, and still being paid for, at the provider.
    signal: (request.signal ?? null) as AbortSignal | null,
  });
  const { body } = response;
  return {
    ok: response.ok,
    status: response.status,
    text: async () => {
      const said = await response.text();
      return said;
    },
    ...(body === null ? {} : { stream: () => decoded(body) }),
  };
};
