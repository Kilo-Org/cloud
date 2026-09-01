import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { constants, createZstdDecompress } from 'node:zlib';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function complete(buffer: Buffer): boolean {
  if (buffer.length < 5 || buffer.readUInt32LE(0) !== 0xfd2fb528) return false;
  const descriptor = buffer.readUInt8(4);
  const single = (descriptor & 0x20) !== 0;
  const dictionary = descriptor & 3;
  const size = descriptor >>> 6;
  let offset =
    5 +
    (single ? 0 : 1) +
    (dictionary === 3 ? 4 : dictionary) +
    (size === 0 ? (single ? 1 : 0) : 2 ** size);

  for (;;) {
    if (buffer.length - offset < 3) return false;
    const block = buffer.readUIntLE(offset, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) return false;
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (offset > buffer.length) return false;
    if (block & 1) break;
  }
  return offset + (descriptor & 4 ? 4 : 0) === buffer.length;
}

export async function readGatewayRequestBody(
  request: Request,
  limits: { input?: number; output?: number; window?: number } = {}
): Promise<{ text: string } | { status: 400 | 413 | 415 | 499; error: string }> {
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity';
  if (encoding !== 'identity' && encoding !== 'zstd') {
    return { status: 415, error: 'Unsupported Content-Encoding. Use identity or zstd.' };
  }

  const exceeded = new Error('Request body exceeds the gateway resource limit.');
  const chunks: Buffer[] = [];
  const utf8 = new TextDecoder();
  let received = 0;
  let decoded = 0;
  let text = '';
  const input = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > (limits.input ?? MAX_BODY_BYTES)) {
        callback(exceeded);
        return;
      }
      if (encoding === 'zstd') chunks.push(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (encoding === 'zstd' && !complete(Buffer.concat(chunks, received))) {
        callback(new Error('Incomplete zstd request body.'));
        return;
      }
      chunks.length = 0;
      callback();
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > (limits.output ?? MAX_BODY_BYTES)) {
        callback(exceeded);
        return;
      }
      text += utf8.decode(chunk, { stream: true });
      callback();
    },
  });

  try {
    const source = request.body
      ? Readable.fromWeb(request.body as ReadableStream<Uint8Array>)
      : Readable.from([]);
    await pipeline(
      [
        source,
        input,
        ...(encoding === 'zstd'
          ? [
              createZstdDecompress({
                params: { [constants.ZSTD_d_windowLogMax]: limits.window ?? 25 },
              }),
            ]
          : []),
        output,
      ],
      { signal: request.signal }
    );
    return { text: text + utf8.decode() };
  } catch (error) {
    if (request.signal.aborted) {
      return { status: 499, error: 'Request cancelled while reading request body.' };
    }
    if (
      error === exceeded ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ZSTD_error_frameParameter_windowTooLarge')
    ) {
      return { status: 413, error: exceeded.message };
    }
    return {
      status: 400,
      error: encoding === 'zstd' ? 'Invalid zstd request body.' : 'Could not read request body.',
    };
  }
}
