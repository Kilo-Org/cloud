import { describe, expect, it, vi } from 'vitest';

import {
  buildLiveActivityApnsRequest,
  sendLiveActivityApns,
  signApnsJwt,
  type ApnsCredentials,
} from './apns-live-activity';

const TEAM_ID = 'TEAM123456';
const KEY_ID = 'KEY123456';
const TOPIC = 'com.kilocode.kiloapp';

async function generateTestPrivateKeyPem(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(der);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

describe('buildLiveActivityApnsRequest', () => {
  it('builds the Live Activity push URL, headers, and aps payload', () => {
    const request = buildLiveActivityApnsRequest({
      token: 'device-token-1',
      event: 'update',
      contentState: { revision: 7, running: 1 },
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: 'pem', topic: TOPIC },
      authorizationJwt: 'header.payload.sig',
      timestampSeconds: 1_750_000_000,
    });

    expect(request.url).toBe('https://api.push.apple.com/3/device/device-token-1');
    expect(request.headers).toMatchObject({
      authorization: 'bearer header.payload.sig',
      'apns-topic': 'com.kilocode.kiloapp.push-type.liveactivity',
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    });

    const body = JSON.parse(request.body) as {
      aps: {
        timestamp: number;
        event: string;
        'content-state': Record<string, unknown>;
        'attributes-type'?: string;
        attributes?: Record<string, unknown>;
      };
    };
    expect(body.aps.timestamp).toBe(1_750_000_000);
    expect(body.aps.event).toBe('update');
    expect(body.aps['content-state']).toEqual({ revision: 7, running: 1 });
    expect(body.aps['attributes-type']).toBeUndefined();
    expect(body.aps.attributes).toBeUndefined();
  });

  it('adds attributes-type and attributes to a push-to-start payload', () => {
    const request = buildLiveActivityApnsRequest({
      token: 'device-token-1',
      event: 'start',
      contentState: { name: 'ActiveAgentsLiveActivity', props: '{"running":1}' },
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: 'pem', topic: TOPIC },
      authorizationJwt: 'header.payload.sig',
      timestampSeconds: 1_750_000_000,
    });

    const body = JSON.parse(request.body) as {
      aps: {
        timestamp: number;
        event: string;
        'content-state': Record<string, unknown>;
        'attributes-type'?: string;
        attributes?: Record<string, unknown>;
      };
    };
    expect(body.aps.event).toBe('start');
    expect(body.aps['attributes-type']).toBe('LiveActivityAttributes');
    expect(body.aps.attributes).toEqual({});
    expect(body.aps['content-state']).toEqual({
      name: 'ActiveAgentsLiveActivity',
      props: '{"running":1}',
    });
  });
});

describe('signApnsJwt', () => {
  it('signs a JWT whose header carries alg/kid and claims carry iss/iat', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const credentials: ApnsCredentials = {
      teamId: TEAM_ID,
      keyId: KEY_ID,
      privateKeyPem,
      topic: TOPIC,
    };

    const jwt = await signApnsJwt(credentials, 1_750_000_000);

    const [headerPart, claimsPart, signaturePart] = jwt.split('.');
    expect(headerPart).toBeDefined();
    expect(claimsPart).toBeDefined();
    expect(signaturePart).toBeDefined();
    expect(signaturePart).not.toBe('');

    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

    expect(decode(headerPart)).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(decode(claimsPart)).toEqual({ iss: TEAM_ID, iat: 1_750_000_000 });
  });
});

describe('sendLiveActivityApns', () => {
  it('POSTs one Live Activity push per token and counts successes', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));

    const result = await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
      tokens: [
        { token: 'token-a', event: 'start' },
        { token: 'token-b', event: 'update' },
      ],
      contentState: { revision: 1, running: 1 },
      nowSeconds: 1_750_000_000,
      fetchFn,
    });

    expect(result).toEqual({ attempted: 2, ok: 2, failed: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstUrl = fetchFn.mock.calls[0]?.[0] as string;
    const firstInit = fetchFn.mock.calls[0]?.[1] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(firstUrl).toBe('https://api.push.apple.com/3/device/token-a');
    expect(firstInit.method).toBe('POST');
    expect(firstInit.headers['apns-push-type']).toBe('liveactivity');
    expect(firstInit.headers.authorization).toMatch(/^bearer /);
    const body = JSON.parse(firstInit.body) as {
      aps: { event: string; 'content-state': Record<string, unknown> };
    };
    expect(body.aps.event).toBe('start');
    expect(body.aps['content-state']).toEqual({ revision: 1, running: 1 });
  });

  it('counts rejected pushes as failures', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 400 }));

    const result = await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
      tokens: [
        { token: 'token-ok', event: 'start' },
        { token: 'token-bad', event: 'update' },
      ],
      contentState: { revision: 2, running: 0 },
      nowSeconds: 1_750_000_000,
      fetchFn,
    });

    expect(result).toEqual({ attempted: 2, ok: 1, failed: 1 });
  });

  it('returns a zero result without signing or fetching when there are no tokens', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: 'not-a-key', topic: TOPIC },
      tokens: [],
      contentState: { revision: 3, running: 0 },
      nowSeconds: 1_750_000_000,
      fetchFn,
    });

    expect(result).toEqual({ attempted: 0, ok: 0, failed: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
