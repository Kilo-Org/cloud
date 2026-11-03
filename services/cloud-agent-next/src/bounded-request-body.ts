const INITIAL_BUFFER_BYTES = 64 * 1024;
/** Consecutive empty reads tolerated in a body stream. */
const MAX_EMPTY_READ_RUN = 4096;
export const SANDBOX_OUTBOUND_BODY_READ_DEADLINE_MS = 30_000;

/**
 * Reads a clone of the request body into one growable buffer while applying
 * maxBytes and a total read deadline; returns `undefined` when either bound is
 * reached.
 */
export async function readBoundedRequestBodyBytes(
  request: Request,
  maxBytes: number,
  deadlineMs = SANDBOX_OUTBOUND_BODY_READ_DEADLINE_MS
): Promise<Uint8Array | undefined> {
  const body: ReadableStream<Uint8Array> | null = request.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => {
    deadlineTimer = setTimeout(() => resolve('timeout'), deadlineMs);
  });
  let buffer = new Uint8Array(Math.min(INITIAL_BUFFER_BYTES, maxBytes));
  let total = 0;
  let emptyReadRun = 0;
  try {
    for (;;) {
      const raced = await Promise.race([reader.read(), deadline]);
      if (raced === 'timeout') return undefined;
      if (raced.done) break;
      const value = raced.value;
      if (value.byteLength === 0) {
        if (++emptyReadRun > MAX_EMPTY_READ_RUN) return undefined;
        continue;
      }
      emptyReadRun = 0;
      if (total + value.byteLength > maxBytes) return undefined;
      if (total + value.byteLength > buffer.byteLength) {
        const next = new Uint8Array(
          Math.min(maxBytes, Math.max(buffer.byteLength * 2, total + value.byteLength))
        );
        next.set(buffer);
        buffer = next;
      }
      buffer.set(value, total);
      total += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(deadlineTimer);
    reader.cancel().catch(() => {});
  }
  return buffer.subarray(0, total);
}
