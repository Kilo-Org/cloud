import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EgressAuditRequest } from '@kilocode/worker-utils/egress-audit';
import { EgressTransportError } from './destination.js';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import { createScmAuthority, type ScmAuthority } from './certificates.js';
import { createEgressServer } from './server.js';

const claims = {
  type: 'aws_egress',
  aud: 'kilo-aws-egress',
  sandboxId: 'sbx_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
  credential: 'a'.repeat(64),
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
const proxies: ReturnType<typeof createEgressServer>[] = [];
afterAll(() => {
  for (const proxy of proxies) proxy.close();
});
async function fixture(overrides: Partial<AwsEgressPolicy> = {}) {
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
  const proxy = createEgressServer({
    control,
    resolve,
    tls: { certificate: authority.certificate, privateKey: authority.privateKey },
    expiresAt: Date.parse(authority.expiresAt),
  });
  proxies.push(proxy);
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const address = proxy.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  const port = address.port;
  async function tunnel(
    host = 'github.com',
    authenticated = true
  ): Promise<{ socket: Socket; header: string }> {
    const socket = connect({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write(
      `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${authenticated ? 'Proxy-Authorization: Basic ' + Buffer.from('kilo:' + token).toString('base64') + '\r\n' : ''}\r\n`
    );
    const header = await new Promise<string>((resolve, reject) => {
      let body = Buffer.alloc(0);
      function data(chunk: Buffer) {
        body = Buffer.concat([body, chunk]);
        const end = body.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.pause();
        socket.off('data', data);
        if (body.length > end + 4) socket.unshift(body.subarray(end + 4));
        resolve(body.subarray(0, end + 4).toString());
      }
      socket.on('data', data);
      socket.once('error', reject);
    });
    return { socket, header };
  }
  return { proxy, tunnel, control, resolve, port };
}
describe('actual CONNECT and SCM TLS front end', () => {
  it('authenticates CONNECT, verifies SCM TLS, and streams the request through its one forwarding interface', async () => {
    const f = await fixture();
    const { socket, header } = await f.tunnel();
    expect(header).toContain('200 Connection Established');
    const secure = connectTls({ socket, servername: 'github.com', ca: authority.caCertificate });
    try {
      await once(secure, 'secureConnect');
      expect(secure.authorized).toBe(true);
      secure.write(
        'POST /acme/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nAuthorization: Bearer alias\r\nContent-Length: 7\r\nConnection: close\r\n\r\nrequest'
      );
      const chunks: Buffer[] = [];
      for await (const chunk of secure) chunks.push(chunk);
      const response = Buffer.concat(chunks).toString();
      expect(response).toContain('200 OK');
      expect(response).toContain('git-response');
      expect(f.control.forwardScm).toHaveBeenCalledOnce();
      const request = f.control.forwardScm.mock.calls[0][1];
      expect(request.url).toBe('https://github.com/acme/repo.git/git-upload-pack');
      expect(request.headers.get('authorization')).toBe('Bearer alias');
      expect(await request.text()).toBe('request');
      expect(f.control.recordAudit.mock.calls[0][1]).toMatchObject({
        method: 'CONNECT',
        scope: 'connection',
        hostname: 'github.com',
        decision: 'allowed',
      });
      expect(f.control.recordAudit.mock.calls[1][1]).toMatchObject({
        method: 'POST',
        hostname: 'github.com',
        decision: 'allowed',
      });
    } finally {
      secure.destroy();
      f.proxy.close();
    }
  });
  it('refuses plain HTTP and persists its actual method without forwarding it', async () => {
    const f = await fixture();
    const socket = connect({ host: '127.0.0.1', port: f.port });
    await once(socket, 'connect');
    socket.write(
      'GET http://public.example/test HTTP/1.1\r\nHost: public.example\r\nProxy-Authorization: Basic ' +
        Buffer.from('kilo:' + token).toString('base64') +
        '\r\nConnection: close\r\n\r\n'
    );
    let response = '';
    for await (const chunk of socket) response += chunk.toString();
    expect(response).toContain('403 Forbidden');
    expect(f.control.recordAudit.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      protocol: 'http:',
      hostname: 'public.example',
      decision: 'denied',
    });
    expect(f.control.forwardScm).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    f.proxy.close();
  });
  it('challenges missing identity and audits refused destinations before returning denial', async () => {
    const f = await fixture({ allowlist: ['worker.example'] });
    const unauthenticated = await f.tunnel('github.com', false);
    expect(unauthenticated.header).toContain('407 Proxy Authentication Required');
    expect(unauthenticated.header).toContain('Proxy-Authenticate: Basic');
    unauthenticated.socket.destroy();
    const denied = await f.tunnel();
    expect(denied.header).toContain('403 Forbidden');
    denied.socket.destroy();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.control.recordAudit.mock.calls[0][1]).toMatchObject({ decision: 'denied' });
    f.proxy.close();
  });
  it('refuses a private resolved address and fails closed when audit persistence fails', async () => {
    const f = await fixture({ interceptedHosts: [] });
    const privateTarget = await f.tunnel('private.example');
    expect(privateTarget.header).toContain('403 Forbidden');
    privateTarget.socket.destroy();
    expect(f.control.recordAudit.mock.calls[0][1]).toMatchObject({ decision: 'denied' });
    f.resolve.mockRejectedValueOnce(new EgressTransportError('destination_denied'));
    const resolvedPrivate = await f.tunnel('private.example');
    expect(resolvedPrivate.header).toContain('403 Forbidden');
    resolvedPrivate.socket.destroy();
    expect(f.control.recordAudit).toHaveBeenCalledTimes(2);
    f.control.recordAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    const failed = await f.tunnel('private.example');
    expect(failed.header).toContain('503 Service Unavailable');
    failed.socket.destroy();
    f.proxy.close();
  });
});
