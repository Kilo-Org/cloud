import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect as connectTls } from 'node:tls';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { EgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { createScmAuthority, type ScmAuthority } from './certificates.js';
import { createTransparentTlsServer } from './transparent-tls.js';
import { createTransparentHttpServer } from './transparent-http.js';
import { createEc2TestAccess } from './ec2-test-access.js';

const claims = {
  type: 'aws_ec2_egress',
  aud: 'kilo-aws-ec2-egress',
  sandboxId: 'sbx_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'i-1234567890abcdef0',
  generation: '22222222-2222-4222-8222-222222222222',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  exp: 2_000_000_000,
};
const token = [
  'header',
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'signature',
].join('.');
let authority: ScmAuthority;
beforeAll(async () => {
  authority = await createScmAuthority();
});
function fixture(overrides: Partial<AwsEgressPolicy> = {}) {
  const policy: AwsEgressPolicy = {
    protocolVersion: 1,
    generation: claims.generation,
    stackId: claims.stackId,
    sandboxId: claims.sandboxId,
    allocationId: claims.allocationId,
    allocationRef: 'allocation-1',
    validUntil: Date.now() + 30_000,
    audit: true,
    interceptedHosts: ['github.com'],
    ...overrides,
  };
  const control = {
    loadPolicy: vi.fn(async () => policy),
    recordAudit: vi.fn(
      async (_token: string, _row: EgressAuditRequest, _signal: AbortSignal) => {}
    ),
    forwardScm: vi.fn(
      async (_token: string, _request: Request, _signal: AbortSignal) =>
        new Response('git-response')
    ),
  };
  const resolve = vi.fn(async () => ['127.0.0.1']);
  return { control, resolve };
}

describe('transparent HTTP ingress', () => {
  it('forwards ordinary HTTP to a checked address and denies unmanaged destinations', async () => {
    const f = fixture({ allowlist: ['example.com', 'github.com'] });
    const forward = vi.fn(async (_request: Request, _address: string) => new Response('ok'));
    const proxy = createTransparentHttpServer({
      control: f.control,
      token,
      resolve: async () => ['1.1.1.1'],
      forward,
      expiresAt: Date.parse(authority.expiresAt),
    });
    proxy.server.listen(0, '127.0.0.1');
    await once(proxy.server, 'listening');
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy address');
    const throughHost = (host: string) =>
      new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const request = get(
          { hostname: '127.0.0.1', port: address.port, path: '/artifact', headers: { host } },
          async response => {
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of response) chunks.push(chunk);
              resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() });
            } catch (error) {
              reject(error);
            }
          }
        );
        request.once('error', reject);
      });
    try {
      const allowed = await throughHost('example.com');
      expect(allowed).toEqual({ status: 200, body: 'ok' });
      expect(forward.mock.calls[0]?.[0].url).toBe('http://example.com/artifact');
      expect(forward.mock.calls[0]?.[1]).toBe('1.1.1.1');
      for (const host of ['example.net', 'github.com']) {
        const blocked = await throughHost(host);
        expect(blocked.status).toBe(403);
      }
      expect(forward).toHaveBeenCalledTimes(1);
      expect(f.control.recordAudit.mock.calls.map(([, row]) => row.decision)).toEqual([
        'allowed',
        'denied',
        'denied',
      ]);
    } finally {
      proxy.close();
    }
  });
});

describe('transparent TLS ingress', () => {
  it('adds test Access proof to HTTP and WebSocket callbacks after egress admission', async () => {
    const hostname = 'api.github.com';
    const origin = `https://${hostname}`;
    const testAccess = createEc2TestAccess(
      { origin, clientId: 'fixture.access', clientSecret: 'fixture_secret' },
      origin
    );
    const f = fixture();
    const requests: Array<{ path?: string; headers: Record<string, unknown> }> = [];
    const material = { privateKey: authority.privateKey, certificate: authority.certificate };
    const upstream = createHttpsServer(
      { key: material.privateKey, cert: material.certificate },
      (incoming, response) => {
        requests.push({ path: incoming.url, headers: incoming.headers });
        incoming.resume();
        response
          .writeHead(200, {
            'Set-Cookie': 'CF_Authorization=fixture_assertion',
            'Cf-Access-Jwt-Assertion': 'fixture_assertion',
          })
          .end('callback received');
      }
    );
    upstream.on('upgrade', (incoming, socket) => {
      requests.push({ path: incoming.url, headers: incoming.headers });
      const accept = createHash('sha1')
        .update(incoming.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\nSet-Cookie: CF_Authorization=fixture_assertion\r\n\r\n`
      );
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('Missing upstream address');
    const proxy = createTransparentTlsServer({
      control: f.control,
      token,
      testAccess,
      resolve: async () => ['1.1.1.1'],
      certificate: async () => material,
      expiresAt: Date.parse(authority.expiresAt),
      send: options => {
        expect(options.hostname).toBe('1.1.1.1');
        expect(options.servername).toBe(hostname);
        return httpsRequest({
          ...options,
          hostname: '127.0.0.1',
          port: upstreamAddress.port,
          ca: authority.caCertificate,
        });
      },
    });
    proxy.server.listen(0, '127.0.0.1');
    await once(proxy.server, 'listening');
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy address');
    const port = address.port;
    async function exchange(line: string, headers: string) {
      const socket = connectTls({
        host: '127.0.0.1',
        port,
        servername: hostname,
        ca: authority.caCertificate,
      });
      try {
        await once(socket, 'secureConnect');
        socket.write(
          `${line}\r\nHost: ${hostname}\r\nAuthorization: Bearer workload\r\n` +
            'CF-Access-Client-Secret: spoofed\r\nCookie: CF_Authorization=spoofed\r\n' +
            headers +
            '\r\n'
        );
        const chunks: Buffer[] = [];
        for await (const chunk of socket) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
      } finally {
        socket.destroy();
      }
    }
    try {
      expect(await exchange('GET /health HTTP/1.1', 'Connection: close\r\n')).toContain(
        '403 Forbidden'
      );
      const response = await exchange(
        'POST /sandbox-control/sbx_test/startup-failure HTTP/1.1',
        'Content-Length: 0\r\nConnection: close\r\n'
      );
      expect(response).toContain('callback received');
      expect(response).not.toContain('fixture_assertion');
      const upgraded = await exchange(
        'GET /sandbox-control/sbx_test HTTP/1.1',
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
      );
      expect(upgraded).toContain('101 Switching Protocols');
      expect(upgraded).not.toContain('fixture_assertion');
      expect(requests.map(({ path }) => path)).toEqual([
        '/sandbox-control/sbx_test/startup-failure',
        '/sandbox-control/sbx_test',
      ]);
      for (const { headers } of requests) {
        expect(headers).toMatchObject({
          authorization: 'Bearer workload',
          'cf-access-client-id': 'fixture.access',
          'cf-access-client-secret': 'fixture_secret',
        });
        expect(headers).not.toHaveProperty('cookie');
      }
    } finally {
      proxy.close();
      upstream.close();
    }
  });

  it('brokers a normal Git HTTPS stream through the host proof', async () => {
    const f = fixture();
    const certificate = vi.fn(async () => ({
      certificate: authority.certificate,
      privateKey: authority.privateKey,
    }));
    const proxy = createTransparentTlsServer({
      control: f.control,
      token,
      resolve: f.resolve,
      certificate,
      expiresAt: Date.parse(authority.expiresAt),
    });
    proxy.server.listen(0, '127.0.0.1');
    await once(proxy.server, 'listening');
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy address');
    const socket = connectTls({
      host: '127.0.0.1',
      port: address.port,
      servername: 'github.com',
      ca: authority.caCertificate,
    });
    try {
      await once(socket, 'secureConnect');
      socket.write(
        'GET /o/r.git/info/refs HTTP/1.1\r\nHost: github.com\r\nConnection: close\r\n\r\n'
      );
      const chunks: Buffer[] = [];
      for await (const chunk of socket) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toContain('git-response');
      expect(f.control.forwardScm.mock.calls[0][0]).toBe(token);
      expect(f.control.forwardScm.mock.calls[0][1].url).toBe(
        'https://github.com/o/r.git/info/refs'
      );
      expect(f.resolve).not.toHaveBeenCalled();
      expect(certificate).toHaveBeenCalledWith('github.com');
    } finally {
      socket.destroy();
      proxy.close();
    }
  });

  it('refuses new Git requests after revocation and closes a live stream at lease expiry', async () => {
    const f = fixture();
    const policy = await f.control.loadPolicy();
    f.control.loadPolicy.mockResolvedValue({ ...policy, validUntil: Date.now() + 1_500 });
    const cancelled = Promise.withResolvers<void>();
    f.control.forwardScm.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('git-stream-started'));
          },
          cancel() {
            cancelled.resolve();
          },
        })
      )
    );
    const proxy = createTransparentTlsServer({
      control: f.control,
      token,
      resolve: f.resolve,
      certificate: async () => ({
        certificate: authority.certificate,
        privateKey: authority.privateKey,
      }),
      expiresAt: Date.parse(authority.expiresAt),
    });
    proxy.server.listen(0, '127.0.0.1');
    await once(proxy.server, 'listening');
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy address');
    const connect = () =>
      connectTls({
        host: '127.0.0.1',
        port: address.port,
        servername: 'github.com',
        ca: authority.caCertificate,
      });
    const active = connect();
    try {
      await once(active, 'secureConnect');
      active.write('GET /o/r.git/info/refs HTTP/1.1\r\nHost: github.com\r\n\r\n');
      let received = '';
      const started = Promise.withResolvers<void>();
      active.on('data', chunk => {
        received += chunk.toString();
        if (received.includes('git-stream-started')) started.resolve();
      });
      await started.promise;

      const closed = once(active, 'close');
      f.control.loadPolicy.mockRejectedValue(new Error('Allocation revoked'));
      const refused = connect();
      try {
        await expect(once(refused, 'secureConnect')).rejects.toThrow();
      } finally {
        refused.destroy();
      }
      await Promise.all([closed, cancelled.promise]);
      expect(f.control.forwardScm).toHaveBeenCalledTimes(1);
    } finally {
      active.destroy();
      proxy.close();
    }
  });
});
