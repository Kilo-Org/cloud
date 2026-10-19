/**
 * Bounded request-body readers shared by routes that read request bodies.
 * Each reader applies its size bound while the stream is read and cancels the
 * stream once the bound is reached.
 */

const INITIAL_BUFFER_BYTES = 64 * 1024;
const MAX_BODY_READS = 4096;
export const SANDBOX_OUTBOUND_BODY_READ_DEADLINE_MS = 30_000;

export async function readBoundedBodyBytes(
  request: Request,
  maxBytes: number
): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reads = 0;
  try {
    for (;;) {
      const result = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (result.done) break;
      if (++reads > MAX_BODY_READS || total + result.value.byteLength > maxBytes) {
        return null;
      }
      total += result.value.byteLength;
      chunks.push(result.value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

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
  try {
    for (;;) {
      const raced = await Promise.race([reader.read(), deadline]);
      if (raced === 'timeout') return undefined;
      if (raced.done) break;
      const value = raced.value;
      if (value.byteLength === 0) continue;
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
