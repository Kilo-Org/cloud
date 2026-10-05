/**
 * Bounded request-body reading shared by the log-upload and worktree-state
 * routes. Both accept a browser/R2-adjacent upload whose size must be refused
 * before the whole body is buffered into the isolate.
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

export function declaredLength(header: string | undefined): number | undefined | 'invalid' {
  if (header === undefined) return undefined;
  if (!/^\d+$/.test(header)) return 'invalid';
  return Number(header);
}
