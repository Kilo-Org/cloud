import { once } from 'node:events';
import { createServer, connect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import { createScmAuthority } from './certificates.js';

describe('immutable SCM TLS authority', () => {
  it('accepts the standard host through an actual TLS client and retains no CA signing key', async () => {
    const material = await createScmAuthority();
    expect(Object.keys(material).sort()).toEqual([
      'caCertificate',
      'certificate',
      'expiresAt',
      'privateKey',
    ]);
    const leaf = new X509Certificate(material.certificate);
    expect(new Date(material.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 28 * 24 * 60 * 60_000
    );
    for (const hostname of STANDARD_SCM_HOSTS) expect(leaf.checkHost(hostname)).toBe(hostname);
    expect(leaf.checkHost('worker.kilosessions.ai')).toBeUndefined();
    const server = createServer({ key: material.privateKey, cert: material.certificate }, socket =>
      socket.end('tls-ok')
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TLS address');
    const socket = connect({
      host: '127.0.0.1',
      port: address.port,
      servername: 'api.github.com',
      ca: material.caCertificate,
    });
    try {
      await once(socket, 'secureConnect');
      expect(socket.authorized).toBe(true);
      let body = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        body += chunk;
      });
      await once(socket, 'end');
      expect(body).toBe('tls-ok');
    } finally {
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);
});
