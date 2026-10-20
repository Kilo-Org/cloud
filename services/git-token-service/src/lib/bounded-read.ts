export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

async function readBoundedBytes(
  stream: ReadableStream<unknown>,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('bounded read received a non-Uint8Array chunk');
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read still fails closed if cancellation itself fails.
        }
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJsonBody(
  stream: ReadableStream<unknown>,
  maxBytes: number
): Promise<unknown> {
  const body = await readBoundedBytes(stream, maxBytes);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
}
