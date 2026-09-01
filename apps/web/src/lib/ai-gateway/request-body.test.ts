import { constants, zstdCompressSync } from 'node:zlib';
import { readGatewayRequestBody } from './request-body';

const text = JSON.stringify(
  {
    model: '',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Preserve café, 日本語, and whitespace.\n' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        reasoning_details: [
          {
            type: 'reasoning.encrypted',
            data: 'cHJlc2VydmUtb3BhcXVlLWJ5dGVz+/==',
            format: 'opaque',
          },
        ],
      },
    ],
  },
  null,
  2
);
const bytes = Buffer.from(text);
const frame = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

function request(body: BodyInit | null, encoding?: string, signal?: AbortSignal) {
  const init = {
    method: 'POST',
    body,
    signal,
    duplex: 'half',
    headers: {
      'content-type': 'application/json',
      ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
    },
  };
  return new Request('http://localhost/api/openrouter/chat/completions', init);
}

function chunked(buffer: Buffer) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < buffer.length; offset += 7) {
        controller.enqueue(buffer.subarray(offset, offset + 7));
      }
      controller.close();
    },
  });
}

describe('readGatewayRequestBody', () => {
  it.each([undefined, 'identity', ' IDENTITY\t', 'zstd', '\tZsTd '])(
    'preserves exact image and encrypted reasoning JSON with encoding %s',
    async encoding => {
      const body = encoding?.trim().toLowerCase() === 'zstd' ? frame : bytes;
      await expect(readGatewayRequestBody(request(chunked(body), encoding))).resolves.toEqual({
        text,
      });
    }
  );

  it('matches Request.text UTF-8 and BOM handling', async () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes, Buffer.from([0xff])]);
    const expected = await request(body).text();
    await expect(readGatewayRequestBody(request(chunked(body)))).resolves.toEqual({
      text: expected,
    });
    await expect(readGatewayRequestBody(request(zstdCompressSync(body), 'zstd'))).resolves.toEqual({
      text: expected,
    });
  });

  it('preserves empty identity bodies', async () => {
    await expect(readGatewayRequestBody(request(null))).resolves.toEqual({ text: '' });
  });

  it.each(['', 'gzip', 'br', 'unknown', 'zstd, identity', 'identity, zstd', 'zstd, zstd'])(
    'rejects unsupported or stacked encoding %s',
    async encoding => {
      const input = request(frame, encoding);
      await expect(readGatewayRequestBody(input)).resolves.toEqual({
        status: 415,
        error: 'Unsupported Content-Encoding. Use identity or zstd.',
      });
      expect(input.bodyUsed).toBe(false);
    }
  );

  it.each([0, 4, 6, frame.length - 1])('rejects a frame truncated to %i bytes', async length => {
    await expect(
      readGatewayRequestBody(request(chunked(frame.subarray(0, length)), 'zstd'))
    ).resolves.toEqual({ status: 400, error: 'Invalid zstd request body.' });
  });

  it.each([bytes, Buffer.concat([frame, Buffer.from([0])])])(
    'rejects invalid frame data',
    async body => {
      await expect(readGatewayRequestBody(request(body, 'zstd'))).resolves.toEqual({
        status: 400,
        error: 'Invalid zstd request body.',
      });
    }
  );

  it('rejects a complete frame with a corrupt checksum', async () => {
    const corrupt = Buffer.from(frame);
    corrupt.writeUInt8(corrupt.readUInt8(corrupt.length - 1) ^ 0xff, corrupt.length - 1);
    await expect(readGatewayRequestBody(request(corrupt, 'zstd'))).resolves.toEqual({
      status: 400,
      error: 'Invalid zstd request body.',
    });
  });

  it('rejects concatenated and skippable frames instead of silently dropping bytes', async () => {
    const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3]);
    for (const body of [Buffer.concat([frame, frame]), Buffer.concat([frame, skip]), skip]) {
      await expect(readGatewayRequestBody(request(body, 'zstd'))).resolves.toEqual({
        status: 400,
        error: 'Invalid zstd request body.',
      });
    }
  });

  it('accepts frames without a declared content size', async () => {
    const body = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
    await expect(readGatewayRequestBody(request(body, 'zstd'))).resolves.toEqual({ text });
  });

  it.each(['identity', 'zstd'])(
    'enforces actual input and output byte limits for %s',
    async encoding => {
      const body = encoding === 'zstd' ? frame : bytes;
      await expect(
        readGatewayRequestBody(request(chunked(body), encoding), {
          input: body.length,
          output: bytes.length,
        })
      ).resolves.toEqual({ text });
      const input = request(chunked(body), encoding);
      input.headers.set('content-length', '1');
      await expect(
        readGatewayRequestBody(input, { input: body.length - 1, output: bytes.length })
      ).resolves.toEqual({
        status: 413,
        error: 'Request body exceeds the gateway resource limit.',
      });
      await expect(
        readGatewayRequestBody(request(body, encoding), { output: bytes.length - 1 })
      ).resolves.toEqual({
        status: 413,
        error: 'Request body exceeds the gateway resource limit.',
      });
    }
  );

  it('enforces the native decoder window limit before output exceeds its limit', async () => {
    const body = zstdCompressSync(Buffer.alloc(2048, 65), {
      params: { [constants.ZSTD_c_contentSizeFlag]: 0, [constants.ZSTD_c_windowLog]: 12 },
    });
    await expect(
      readGatewayRequestBody(request(body, 'zstd'), { window: 10, output: 4096 })
    ).resolves.toEqual({ status: 413, error: 'Request body exceeds the gateway resource limit.' });
  });

  it.each(['identity', 'zstd'])('cancels a stalled %s body read', async encoding => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue((encoding === 'zstd' ? frame : bytes).subarray(0, 4));
      },
      pull() {
        started.resolve();
      },
      cancel(reason) {
        cancelled.resolve(reason);
      },
    });
    const result = readGatewayRequestBody(request(body, encoding, controller.signal));
    await started.promise;
    controller.abort();
    await expect(result).resolves.toEqual({
      status: 499,
      error: 'Request cancelled while reading request body.',
    });
    await expect(cancelled.promise).resolves.toMatchObject({ name: 'AbortError' });
  });

  it('does not decode an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readGatewayRequestBody(request(frame, 'zstd', controller.signal))
    ).resolves.toMatchObject({ status: 499 });
  });
});
