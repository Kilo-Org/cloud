import { request, createServer } from 'node:https';
import { once } from 'node:events';
import { beforeAll, describe, expect, it } from 'vitest';
import { createScmAuthority, type ScmAuthority } from './certificates.js';
import { fetchAtAddress, type HttpsRequestFactory } from './https-transport.js';

let material: ScmAuthority;
beforeAll(async () => {
  material = await createScmAuthority();
});

describe('actual pinned HTTPS transport', () => {
  it('rejects an invalid WHATWG status without throwing from its response callback', async () => {
    const server = createServer(
      { key: material.privateKey, cert: material.certificate },
      (_incoming, response) => {
        response.writeHead(600).end('nonstandard upstream status');
      }
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const factory: HttpsRequestFactory = options => {
      expect(options.hostname).toBe('1.1.1.1');
      expect(options.servername).toBe('api.github.com');
      return request({
        ...options,
        hostname: '127.0.0.1',
        port: address.port,
        ca: material.caCertificate,
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          fetchAtAddress(new Request('https://api.github.com/fixture'), '1.1.1.1', factory),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('response conversion stalled')), 1000);
          }),
        ])
      ).rejects.toThrow('connection_failed');
    } finally {
      if (timer) clearTimeout(timer);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
