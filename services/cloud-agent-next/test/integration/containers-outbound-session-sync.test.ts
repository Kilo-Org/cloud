import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ContainersOutbound,
  type ContainersOutboundProps,
} from '../../src/sandbox-containers/containers-outbound.js';
import { waitFor } from './wait-for.js';

const props: ContainersOutboundProps = {
  containerId: 'container-session-sync',
  egressAllowlist: ['session-sync.kiloapps.io'],
};

function outbound(workerEnv: unknown = env): ContainersOutbound {
  return new ContainersOutbound(
    Object.assign(createExecutionContext(), { props }),
    workerEnv as Cloudflare.Env
  );
}

const SESSION_PROTOCOL = 'kilo-session-ticket.synthetic';

function upgradeRequest(url = 'https://session-sync.kiloapps.io/v1/sessions/ses_synthetic/live') {
  return new Request(url, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': SESSION_PROTOCOL,
      Authorization: 'Bearer synthetic-handle',
    },
  });
}

describe('ContainersOutbound Session Sync WebSocket', () => {
  it('passes a 101 upgrade and two-way frames through the SESSION_SYNC binding', async () => {
    const response = await outbound().fetch(upgradeRequest());
    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(SESSION_PROTOCOL);
    const socket = response.webSocket;
    if (!socket) throw new Error('Missing upgraded WebSocket');
    socket.accept();
    const frames: string[] = [];
    socket.addEventListener('message', event => {
      frames.push(String(event.data));
    });

    await waitFor(async () => expect(frames.length).toBe(1));
    expect(JSON.parse(frames[0] ?? '')).toEqual({
      path: '/v1/sessions/ses_synthetic/live',
      upgrade: 'websocket',
      protocol: SESSION_PROTOCOL,
      authorization: 'Bearer synthetic-handle',
    });

    socket.send('client-frame');
    await waitFor(async () => expect(frames.length).toBe(2));
    expect(frames[1]).toBe('echo:client-frame');
    socket.close(1000, 'done');
  });

  it.each([
    'http://session-sync.kiloapps.io/v1/sessions/ses_synthetic/live',
    'https://session-sync.kiloapps.io./v1/sessions/ses_synthetic/live',
    'https://outside.test/v1/sessions/ses_synthetic/live',
  ])('denies egress before the binding: %s', async url => {
    const response = await outbound().fetch(upgradeRequest(url));
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it('fails closed when the binding is missing', async () => {
    const response = await outbound({}).fetch(upgradeRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'auth_unavailable', retryable: true },
    });
    expect(response.webSocket).toBeNull();
  });
});
