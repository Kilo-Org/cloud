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

export function concatenateBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== size) throw new Error('Compressed export size does not match its chunks');
  return result;
}

export function gzipMemberFitsPart(
  currentSize: number,
  memberSize: number,
  partSize: number,
  minimumPaddingSize: number
): boolean {
  const remaining = partSize - currentSize - memberSize;
  return remaining === 0 || remaining >= minimumPaddingSize;
}
