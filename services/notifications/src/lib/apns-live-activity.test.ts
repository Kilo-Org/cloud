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
        alert?: { title: string; body: string };
      };
    };
    expect(body.aps.timestamp).toBe(1_750_000_000);
    expect(body.aps.event).toBe('update');
    expect(body.aps['content-state']).toEqual({ revision: 7, running: 1 });
    expect(body.aps['attributes-type']).toBeUndefined();
    expect(body.aps.attributes).toBeUndefined();
    expect(body.aps.alert).toBeUndefined();
  });

  it('adds attributes-type, attributes, and the required alert to a push-to-start payload', () => {
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
        alert?: { title: string; body: string };
      };
    };
    expect(body.aps.event).toBe('start');
    expect(body.aps['attributes-type']).toBe('LiveActivityAttributes');
    expect(body.aps.attributes).toEqual({});
    // Apple rejects a push-to-start payload that carries no alert.
    expect(body.aps.alert).toEqual({ title: 'Kilo', body: 'Your agents are running.' });
    expect(body.aps['content-state']).toEqual({
      name: 'ActiveAgentsLiveActivity',
      props: '{"running":1}',
    });
  });
});

describe('APNs terminal contract', () => {
  it('encodes final content and a native dismissal date without start attributes', () => {
    const request = buildLiveActivityApnsRequest({
      token: 'ending-activity',
      event: 'end',
      contentState: { name: 'ActiveAgentsLiveActivity', props: '{"status":"empty","running":0}' },
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: 'pem', topic: TOPIC },
      authorizationJwt: 'header.payload.sig',
      timestampSeconds: 1_750_000_000,
      dismissalDateSeconds: 1_750_000_108,
    });
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        timestamp: 1_750_000_000,
        event: 'end',
        'dismissal-date': 1_750_000_108,
        'content-state': {
          name: 'ActiveAgentsLiveActivity',
          props: '{"status":"empty","running":0}',
        },
      },
    });
  });

  it('anchors the terminal window at the send boundary without changing snapshot order', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
    const bodies: unknown[] = [];
    try {
      await sendLiveActivityApns({
        credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
        tokens: [{ token: 'ending-activity', event: 'end' }],
        contentState: { running: 0 },
        nowSeconds: 1_750_000_000,
        timestampSeconds: 1_750_000_001,
        isCurrent: async () => true,
        beforeEnd: async () => {
          clock.mockReturnValue(1_750_000_100_000);
          return true;
        },
        fetchFn: async (_url, init) => {
          if (typeof init?.body !== 'string') throw new Error('Expected a JSON body');
          bodies.push(JSON.parse(init.body));
          return new Response(null, { status: 200 });
        },
      });
      expect(bodies).toEqual([
        {
          aps: {
            event: 'end',
            timestamp: 1_750_000_001,
            'dismissal-date': 1_750_000_108,
            'content-state': { running: 0 },
          },
        },
      ]);
    } finally {
      clock.mockRestore();
    }
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

  it('keeps the snapshot timestamp when signing occurs after a delayed read', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const requests: Array<{ timestamp: number; issuedAt: number }> = [];
    await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
      tokens: [{ token: 'token-delayed', event: 'update' }],
      contentState: { running: 1 },
      nowSeconds: 1_750_000_100,
      timestampSeconds: 1_750_000_000,
      fetchFn: async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON body');
        const body = JSON.parse(init.body) as { aps: { timestamp: number } };
        const authorization = new Headers(init.headers).get('authorization');
        if (!authorization) throw new Error('Missing provider token');
        const claimsPart = authorization.split('.')[1];
        const claims = JSON.parse(atob(claimsPart.replace(/-/g, '+').replace(/_/g, '/'))) as {
          iat: number;
        };
        requests.push({ timestamp: body.aps.timestamp, issuedAt: claims.iat });
        return new Response(null, { status: 200 });
      },
    });
    expect(requests).toEqual([{ timestamp: 1_750_000_000, issuedAt: 1_750_000_100 }]);
  });

  it('checks each token after signing and excludes superseded sends from the result', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const secondCheck = Promise.withResolvers<boolean>();
    let first = true;
    const delivered: string[] = [];

    const result = await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
      tokens: [
        { token: 'token-current', event: 'start' },
        { token: 'token-superseded', event: 'start' },
      ],
      contentState: { running: 1 },
      nowSeconds: 1_750_000_000,
      isCurrent: async () => {
        if (!first) return secondCheck.promise;
        first = false;
        return true;
      },
      fetchFn: async url => {
        if (typeof url !== 'string') throw new Error('Expected a string URL');
        delivered.push(url);
        secondCheck.resolve(false);
        return new Response(null, { status: 200 });
      },
    });

    expect(delivered).toEqual(['https://api.push.apple.com/3/device/token-current']);
    expect(result).toEqual({ attempted: 1, ok: 1, failed: 0 });
  });

  it('skips an end when the durable intent loses its generation before the request', async () => {
    const privateKeyPem = await generateTestPrivateKeyPem();
    const delivered: string[] = [];
    const result = await sendLiveActivityApns({
      credentials: { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem, topic: TOPIC },
      tokens: [{ token: 'ending-activity', event: 'end' }],
      contentState: { running: 0 },
      nowSeconds: 1_750_000_000,
      isCurrent: async () => true,
      beforeEnd: async () => false,
      fetchFn: async url => {
        if (typeof url !== 'string') throw new Error('Expected a string URL');
        delivered.push(url);
        return new Response(null, { status: 200 });
      },
    });
    expect(delivered).toEqual([]);
    expect(result).toEqual({ attempted: 0, ok: 0, failed: 0 });
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
