/**
 * The body as UTF-8 text, read chunk by chunk with a byte count: null as soon as the count passes
 * `max`, after the rest of the stream is cancelled, so a body without a `Content-Length` (or with
 * a false one) is never held whole in memory.
 */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
