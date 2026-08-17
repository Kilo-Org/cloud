export type UploadedGzipPart = { partNumber: number; etag: string; sizeBytes: number };

export async function uploadGzipStream(input: {
  stream: ReadableStream<Uint8Array>;
  partBytes: number;
  uploadPart: (partNumber: number, value: Uint8Array) => Promise<{ etag: string }>;
}): Promise<UploadedGzipPart[]> {
  const reader = input.stream.getReader();
  const uploaded: UploadedGzipPart[] = [];
  let partNumber = 1;
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

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    let offset = 0;
    while (offset < result.value.byteLength) {
      const length = Math.min(input.partBytes - used, result.value.byteLength - offset);
      buffer.set(result.value.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === input.partBytes) await flush(input.partBytes);
    }
  }

  if (used > 0) await flush(used);
  return uploaded;
}
