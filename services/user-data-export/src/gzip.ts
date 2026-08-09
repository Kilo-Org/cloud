export async function gzipMember(value: string): Promise<Uint8Array> {
  const compressed = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export type UploadedGzipPart = { partNumber: number; etag: string; sizeBytes: number };

export async function uploadGzipStream(input: {
  stream: ReadableStream<Uint8Array>;
  partBytes: number;
  startPartNumber: number;
  isFinal: () => boolean;
  uploadPart: (partNumber: number, value: Uint8Array) => Promise<{ etag: string }>;
}): Promise<UploadedGzipPart[]> {
  const reader = input.stream.getReader();
  const uploaded: UploadedGzipPart[] = [];
  let partNumber = input.startPartNumber;
  let buffer = new Uint8Array(input.partBytes);
  let used = 0;

  const flush = async (size: number) => {
    const value = size === input.partBytes ? buffer : buffer.slice(0, size);
    const part = await input.uploadPart(partNumber, value);
    uploaded.push({ partNumber, etag: part.etag, sizeBytes: size });
    partNumber += 1;
    buffer = new Uint8Array(input.partBytes);
    used = 0;
  };

  const append = async (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(input.partBytes - used, chunk.byteLength - offset);
      buffer.set(chunk.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === input.partBytes) await flush(input.partBytes);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    await append(result.value);
  }

  if (used > 0) {
    if (!input.isFinal()) {
      throw new Error('Non-final compressed export did not fill an R2 multipart part');
    }
    await flush(used);
  }

  return uploaded;
}
