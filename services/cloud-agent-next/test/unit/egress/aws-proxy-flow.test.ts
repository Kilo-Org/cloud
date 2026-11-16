import { once } from 'node:events';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { afterEach, expect, it, vi } from 'vitest';
import { createScmAuthority } from '../../../../sandbox-egress/src/certificates.js';
import { createEgressServer } from '../../../../sandbox-egress/src/server.js';
import { createControlPlaneClient } from '../../../../sandbox-egress/src/control-plane.js';
import { awsEgressFixture } from '../../fixtures/aws-egress.js';
import type { Env } from '../../../src/types.js';
import { handleAwsEgress } from '../../../src/egress/aws-route.js';

afterEach(() => vi.unstubAllGlobals());

it('connects the real proxy TLS and control client to Worker admission and managed forwarding', async () => {
  const f = await awsEgressFixture();
  const authority = await createScmAuthority();
  const workerEnv = {
    ...f.env,
    SANDBOX_CONTROL: {
      getByName: () => ({
        getAwsEgressPolicy: f.api.policy,
        recordAwsEgressAudit: f.api.audit,
        admitAwsScm: f.api.admitScm,
      }),
    },
  } as unknown as Env;
  const operations: string[] = [];
  const control = createControlPlaneClient({
    origin: 'https://worker.test',
    deployment: f.metadata.deployment,
    identity: f.metadata.identity,
    fetch: request => {
      const operation = new URL(request.url).pathname.split('/').at(-1) ?? '';
      operations.push(operation);
      return handleAwsEgress(request, workerEnv, f.context.sandboxId, operation);
    },
  });
  const upstream = vi.fn(async (request: Request) => {
    expect(request.url).toBe('https://github.com/acme/repo.git/info/refs?service=git-upload-pack');
    expect(request.headers.get('authorization')).toBe('Bearer upstream-secret');
    expect(request.headers.has('x-kilo-egress-credential')).toBe(false);
    expect(request.headers.has('proxy-authorization')).toBe(false);
    return new Response('authenticated-git-response');
  });
  vi.stubGlobal('fetch', upstream);
  const proxy = createEgressServer({
    control,
    resolve: async () => ['93.184.216.34'],
    tls: { certificate: authority.certificate, privateKey: authority.privateKey },
    expiresAt: Date.parse(authority.expiresAt),
  });
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  const address = proxy.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  const socket = connect({ host: '127.0.0.1', port: address.port });
  try {
    await once(socket, 'connect');
    socket.write(
      `CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic ${Buffer.from('kilo:' + f.proof.credential).toString('base64')}\r\n\r\n`
    );
    const [header] = await once(socket, 'data');
    expect(String(header)).toContain('200 Connection Established');
    const secure = connectTls({ socket, servername: 'github.com', ca: authority.caCertificate });
    try {
      await once(secure, 'secureConnect');
      expect(secure.authorized).toBe(true);
      secure.write(
        `GET /acme/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nAuthorization: Bearer ${f.scope.scm!.alias}\r\nConnection: close\r\n\r\n`
      );
      const chunks: Buffer[] = [];
      for await (const chunk of secure) chunks.push(chunk);
      const response = Buffer.concat(chunks).toString();
      expect(response).toContain('200 OK');
      expect(response).toContain('authenticated-git-response');
      expect(operations).toContain('policy');
      expect(operations).toContain('audit');
      expect(operations).toContain('scm');
      expect(f.recordEgressRequest.mock.calls.map(([row]) => row)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'CONNECT', decision: 'allowed' }),
          expect.objectContaining({ method: 'GET', decision: 'allowed' }),
        ])
      );
      expect(f.redeem).toHaveBeenCalledOnce();
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      secure.destroy();
    }
  } finally {
    socket.destroy();
    proxy.close();
  }
}, 20_000);
