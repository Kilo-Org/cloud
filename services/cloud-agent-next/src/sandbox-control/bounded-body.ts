/**
 * Request-body helpers shared by the control-plane upload routes.
 *
 * Every one of them buffers its body to hand R2 a known length, so each needs
 * the same two things: a ceiling that is applied while reading rather than
 * after, and a `Content-Length` check that is advisory only — it is a
 * forbidden header the client's fetch layer owns, so a route that depended on
 * it would reject uploads that are perfectly well formed.
 */

/**
 * Reads the whole body, or returns undefined as soon as it passes `maxBytes`
 * so an oversized stream is abandoned instead of buffered.
 */
export async function readBoundedBytes(
  request: Request,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The declared length, `undefined` when absent, or `'invalid'` when malformed. */
export function declaredLength(header: string | undefined): number | undefined | 'invalid' {
  if (header === undefined) return undefined;
  if (!/^\d+$/.test(header)) return 'invalid';
  return Number(header);
}
