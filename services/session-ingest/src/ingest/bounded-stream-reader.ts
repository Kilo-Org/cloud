export type BoundedStreamReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' };

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  declaredBytes: number
): Promise<BoundedStreamReadResult> {
  const reader = stream.getReader();

  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const result = await reader.read();
      if (result.done) {
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { ok: true, bytes };
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > declaredBytes) {
        await cancelReader(reader);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel('stream exceeded ingest byte limit');
  } catch {
    // The typed overflow result remains authoritative if cancellation itself fails.
  }
}
