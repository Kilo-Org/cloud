import { env, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { mintPreviewSessionToken, resolveSecret } from '../../src/auth.js';
import type { PreviewProviderCoordinates } from '../../src/control-plane/sandbox/preview-target.js';
import { previewLabel } from '../../src/preview/host.js';
import { handlePreviewRequest, type PreviewRouteDeps } from '../../src/preview/route.js';
import { fetchPreviewUpstream } from '../../src/preview/upstreams.js';
import { PREVIEW_COOKIE_NAME } from '../../src/shared/preview-headers.js';
import { PREVIEW_TUNNEL_MAX_HTTP_STREAMS } from '../../src/shared/preview-tunnel-protocol.js';
import type { Env } from '../../src/types.js';
import {
  connectTunnelPeer,
  newTunnelIdentity,
  previewTunnelStub,
  type TunnelPeer,
} from './helpers/preview-tunnel-peer.js';

/**
 * The preview route with the real upstream table and the real PreviewTunnel
 * Durable Object. Only access and target resolution are fixed, so each
 * response passes the route's sanitizer exactly as in production.
 */

afterEach(async () => {
  await reset();
});

const SESSION_ID = 'workspace_33333333-3333-4333-8333-333333333333';
const PORT = 5173;
const ORIGIN = `http://${previewLabel(SESSION_ID, PORT)}.preview.test`;
const routeEnv = { ...env, PREVIEW_HOST_SUFFIX: 'preview.test' } as unknown as Env;

type RouteTunnel = { peer: TunnelPeer; deps: PreviewRouteDeps; cookie: string };

async function routeTunnel(): Promise<RouteTunnel> {
  const { sandboxId, allocationId } = newTunnelIdentity();
  const peer = await connectTunnelPeer(previewTunnelStub(sandboxId, allocationId), allocationId);
  const coordinates: PreviewProviderCoordinates = {
    transport: 'wrapper-tunnel',
    provider: 'vercel',
    logicalSandboxId: sandboxId,
    allocationRef: allocationId,
  };
  const deps: PreviewRouteDeps = {
    validateAccess: async () => undefined,
    getSessionStub: () => ({
      resolvePreviewTarget: async () => ({ status: 'ok', coordinates }),
    }),
    resolveWorkspaceTarget: async () => {
      throw new Error('No workspace target in this test');
    },
    consumeTicketNonce: async () => true,
    fetchUpstream: fetchPreviewUpstream,
  };
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (secret === null) throw new Error('The test env has no NEXTAUTH_SECRET');
  const token = mintPreviewSessionToken(
    {
      userId: 'user-1',
      cloudAgentSessionId: SESSION_ID,
      port: PORT,
      provider: coordinates.provider,
      logicalSandboxId: coordinates.logicalSandboxId,
      allocationRef: coordinates.allocationRef,
    },
    secret
  );
  return { peer, deps, cookie: `${PREVIEW_COOKIE_NAME}=${token}` };
}

function browserRequest(tunnel: RouteTunnel, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Cookie', tunnel.cookie);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

describe('preview route through the wrapper tunnel', () => {
  it('runs the response sanitizer on a tunnel response', async () => {
    const tunnel = await routeTunnel();
    const pending = handlePreviewRequest(browserRequest(tunnel, '/app?x=1'), routeEnv, tunnel.deps);
    const open = await tunnel.peer.takeType('open');
    expect(open.open).toMatchObject({ method: 'GET', port: PORT, path: '/app?x=1' });
    const sent = open.open.headers.map(([name]) => name.toLowerCase());
    expect(sent.some(name => name.startsWith('x-kilo-preview'))).toBe(false);
    expect(sent).not.toContain('cookie');

    tunnel.peer.respond(open.stream, 302, 'moved', [
      ['location', `http://localhost:${PORT}/login`],
      ['set-cookie', 'a=1; Domain=example.com; Secure; Path=/'],
      ['set-cookie', 'b=2; Path=/'],
      ['set-cookie', `${PREVIEW_COOKIE_NAME}=forged; Path=/`],
      ['x-frame-options', 'ALLOWALL'],
    ]);
    const response = await pending;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.text()).toBe('moved');
  });

  it('relays a same-origin WebSocket upgrade through the route', async () => {
    const tunnel = await routeTunnel();
    const pending = handlePreviewRequest(
      browserRequest(tunnel, '/hmr', { headers: { Upgrade: 'websocket', Origin: ORIGIN } }),
      routeEnv,
      tunnel.deps
    );
    const open = await tunnel.peer.takeType('ws_open');
    expect(open.open.path).toBe('/hmr');
    tunnel.peer.send({ type: 'ws_accept', stream: open.stream, protocol: '' });
    const response = await pending;
    expect(response.status).toBe(101);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const socket = response.webSocket;
    if (!socket) throw new Error('The upgrade returned no socket');
    socket.accept();
    socket.send('ping');
    expect(await tunnel.peer.takeType('ws_text', open.stream)).toMatchObject({ text: 'ping' });
    socket.close(1000, 'done');
  });

  it('serves 200 concurrent requests through the route', async () => {
    const tunnel = await routeTunnel();
    const total = 200;
    const responses = Array.from({ length: total }, (_, index) =>
      handlePreviewRequest(browserRequest(tunnel, `/module/${index}.js`), routeEnv, tunnel.deps)
    );
    // Hold the heads until the stream cap is reached, so the other requests wait for a slot.
    const held: number[] = [];
    for (let index = 0; index < PREVIEW_TUNNEL_MAX_HTTP_STREAMS; index += 1) {
      held.push((await tunnel.peer.takeType('open', undefined, 15_000)).stream);
    }
    const answerAll = (async () => {
      for (const stream of held) tunnel.peer.respond(stream, 200, `m${stream}`);
      for (let answered = held.length; answered < total; answered += 1) {
        const open = await tunnel.peer.takeType('open', undefined, 15_000);
        tunnel.peer.respond(open.stream, 200, `m${open.stream}`);
      }
    })();
    const results = await Promise.all(
      responses.map(async pending => {
        const response = await pending;
        return { status: response.status, body: await response.text() };
      })
    );
    await answerAll;
    expect(results.filter(result => result.status === 200)).toHaveLength(total);
    expect(results.every(result => result.body.startsWith('m'))).toBe(true);
    expect(tunnel.peer.opens).toBe(total);
  });
});
