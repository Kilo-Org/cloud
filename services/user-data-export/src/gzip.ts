const GZIP_HEADER_BYTES = 10;

export async function gzipMember(value: string): Promise<Uint8Array> {
  const compressed = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function gzipPaddingMember(size: number): Promise<Uint8Array> {
  const emptyMember = await gzipMember('');
  if (
    emptyMember.byteLength < GZIP_HEADER_BYTES + 8 ||
    emptyMember[0] !== 0x1f ||
    emptyMember[1] !== 0x8b ||
    emptyMember[2] !== 0x08 ||
    emptyMember[3] !== 0
  ) {
    throw new Error('Runtime produced an unsupported gzip header');
  }
  if (size < emptyMember.byteLength) {
    throw new Error('Gzip padding is smaller than an empty gzip member');
  }
  if (size === emptyMember.byteLength) return emptyMember;

  const commentLength = size - emptyMember.byteLength - 1;
  const padded = new Uint8Array(size);
  padded.set(emptyMember.subarray(0, GZIP_HEADER_BYTES));
  padded[3] |= 0x08; // FCOMMENT
  padded.fill(0x50, GZIP_HEADER_BYTES, GZIP_HEADER_BYTES + commentLength);
  padded[GZIP_HEADER_BYTES + commentLength] = 0;
  padded.set(emptyMember.subarray(GZIP_HEADER_BYTES), GZIP_HEADER_BYTES + commentLength + 1);
  return padded;
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

  if (used > 0 && !input.isFinal()) {
    const gap = input.partBytes - used;
    const minimumPaddingSize = (await gzipMember('')).byteLength;
    const paddingSize = gap >= minimumPaddingSize ? gap : gap + input.partBytes;
    await append(await gzipPaddingMember(paddingSize));
  }
  if (used > 0) await flush(used);

  return uploaded;
}
