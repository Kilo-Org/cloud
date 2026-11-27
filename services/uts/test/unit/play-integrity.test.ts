import { Buffer } from 'node:buffer';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type PlayIntegrityEndpoints,
  type PlayVerdict,
  type ServiceAccountKey,
  checkPlayVerdict,
  clearAccessTokens,
  parseCertificateDigest,
  playIntegrityDecoder,
} from '../../src/attest/play-integrity';
import {
  type PlayVerdictInput,
  playIntegrityToken,
  playVerdict,
} from '../../scripts/attest-standins';

/**
 * The Play Integrity step: the verdict checks against verdicts shaped like Google's
 * `decodeIntegrityToken` answer, and the decode port against a recording stand-in for Google's
 * token endpoint and API (no network).
 */

const PACKAGE = 'com.kilocode.kiloapp';
const DIGEST = new Uint8Array(32).fill(0xab);
const DIGEST_BASE64URL = Buffer.from(DIGEST).toString('base64url');
const REQUEST_HASH = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
const NOW = Date.UTC(2026, 10, 27, 12);

const expected = { packageName: PACKAGE, certificateDigests: [DIGEST], requestHash: REQUEST_HASH };

/** The verdict as Google's JSON carries it (`timestampMillis` a decimal string). */
function rawVerdict(overrides: Partial<PlayVerdictInput> = {}) {
  return playVerdict({
    requestHash: REQUEST_HASH,
    packageName: PACKAGE,
    certificateDigest: DIGEST_BASE64URL,
    timestampMillis: NOW - 2_000,
    ...overrides,
  });
}

/** The verdict as the decode port returns it after parsing. */
function verdict(overrides: Partial<PlayVerdictInput> = {}): PlayVerdict {
  const raw = rawVerdict(overrides);
  return {
    ...raw,
    requestDetails: {
      ...raw.requestDetails,
      timestampMillis: Number(raw.requestDetails.timestampMillis),
    },
  };
}

describe('checkPlayVerdict', () => {
  it('passes a recent Play-recognized verdict for the package, signer and request hash', () => {
    expect(checkPlayVerdict(verdict(), expected, NOW)).toEqual({ status: 'verified' });
  });

  it.each([
    [
      'another request hash',
      { requestHash: Buffer.from('other').toString('base64') },
      'request_hash_mismatch',
    ],
    ['another package', { packageName: 'com.example.repackaged' }, 'package_mismatch'],
    ['a verdict over 5 minutes old', { timestampMillis: NOW - 6 * 60_000 }, 'stale'],
    ['a verdict from over a minute ahead', { timestampMillis: NOW + 2 * 60_000 }, 'stale'],
    [
      'an unrecognized app version',
      { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' },
      'app_not_recognized',
    ],
    ['an unevaluated app', { appRecognitionVerdict: 'UNEVALUATED' }, 'app_not_recognized'],
    [
      'another signing certificate',
      { certificateDigest: Buffer.alloc(32, 1).toString('base64url') },
      'certificate_mismatch',
    ],
    [
      'basic integrity only',
      { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] },
      'device_integrity',
    ],
    ['no device verdict', { deviceRecognitionVerdict: [] }, 'device_integrity'],
  ])('refuses %s', (_name, overrides, reason) => {
    expect(checkPlayVerdict(verdict(overrides), expected, NOW)).toEqual({
      status: 'refused',
      reason,
    });
  });

  it('refuses a verdict whose request package differs from the app package', () => {
    const mixed = verdict();
    mixed.requestDetails.requestPackageName = 'com.example.other';
    expect(checkPlayVerdict(mixed, expected, NOW)).toEqual({
      status: 'refused',
      reason: 'package_mismatch',
    });
  });
});

describe('parseCertificateDigest', () => {
  it('reads Play Console hex, with or without colons, and base64url or base64', () => {
    const hex = Buffer.from(DIGEST).toString('hex');
    const colons = hex.toUpperCase().match(/../g)?.join(':') ?? '';
    for (const value of [hex, colons, DIGEST_BASE64URL, Buffer.from(DIGEST).toString('base64')]) {
      expect(parseCertificateDigest(value)).toEqual(DIGEST);
    }
  });

  it('refuses anything that is not 32 bytes', () => {
    for (const value of ['', 'abc', 'zz'.repeat(32), Buffer.alloc(20).toString('base64url')]) {
      expect(parseCertificateDigest(value)).toBeNull();
    }
  });
});

describe('playIntegrityDecoder', () => {
  afterEach(() => clearAccessTokens());

  const endpoints: PlayIntegrityEndpoints = {
    tokenUri: 'http://127.0.0.1:9/token',
    apiBase: 'http://127.0.0.1:9/v1',
  };

  async function serviceAccount(): Promise<{ key: ServiceAccountKey; publicPem: string }> {
    const pair = await generateKeyPair('RS256', { extractable: true });
    return {
      key: {
        clientEmail: 'uts-play-integrity@example-project.iam.gserviceaccount.com',
        privateKeyId: 'a'.repeat(40),
        privateKeyPem: await exportPKCS8(pair.privateKey),
      },
      publicPem: await exportSPKI(pair.publicKey),
    };
  }

  type Call = { url: string; body: string; authorization: string | null };

  /** Google's token endpoint and API, answering `decodeStatus` with `decodeBody`. */
  function standIn(decodeStatus: number | 'network', decodeBody: unknown = {}) {
    const calls: Call[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init?.body === 'string'
            ? init.body
            : '';
      calls.push({ url, body, authorization: new Headers(init?.headers).get('Authorization') });
      if (url === endpoints.tokenUri) {
        return Response.json({ access_token: `stand-in-${calls.length}`, expires_in: 3599 });
      }
      if (decodeStatus === 'network') throw new TypeError('network down');
      return Response.json(decodeBody, { status: decodeStatus });
    };
    return { calls, fetcher };
  }

  it('signs a service-account assertion, decodes, and reuses the access token', async () => {
    const { key, publicPem } = await serviceAccount();
    const { calls, fetcher } = standIn(200, { tokenPayloadExternal: rawVerdict() });
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher,
      now: () => Date.now(),
    });
    const token = playIntegrityToken();
    expect(await decode(token)).toMatchObject({ status: 'decoded' });
    expect(await decode(playIntegrityToken())).toMatchObject({ status: 'decoded' });

    expect(calls.map(call => call.url)).toEqual([
      endpoints.tokenUri,
      `${endpoints.apiBase}/${PACKAGE}:decodeIntegrityToken`,
      `${endpoints.apiBase}/${PACKAGE}:decodeIntegrityToken`,
    ]);
    const assertion = new URLSearchParams(calls[0].body).get('assertion') ?? '';
    const { payload, protectedHeader } = await jwtVerify(
      assertion,
      await importSPKI(publicPem, 'RS256'),
      { issuer: key.clientEmail, audience: endpoints.tokenUri }
    );
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: key.privateKeyId });
    expect(payload.scope).toBe('https://www.googleapis.com/auth/playintegrity');
    expect(JSON.parse(calls[1].body)).toEqual({ integrityToken: token });
    expect(calls[1].authorization).toBe('Bearer stand-in-1');
    expect(calls[2].authorization).toBe('Bearer stand-in-1');
  });

  it.each([
    [400, { error: { status: 'INVALID_ARGUMENT' } }, { status: 'invalid_token' }],
    [200, { tokenPayloadExternal: { requestDetails: {} } }, { status: 'invalid_token' }],
    [200, {}, { status: 'invalid_token' }],
    [429, {}, { status: 'unavailable', reason: 'quota' }],
    [503, {}, { status: 'unavailable', reason: 'upstream' }],
    ['network' as const, {}, { status: 'unavailable', reason: 'upstream' }],
  ])('answers Google %s with the right outcome', async (status, body, outcome) => {
    const { key } = await serviceAccount();
    const { fetcher } = standIn(status, body);
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher,
      now: Date.now,
    });
    expect(await decode(playIntegrityToken())).toEqual(outcome);
  });

  it('drops an access token Google refuses, so the next decode gets a new one', async () => {
    const { key } = await serviceAccount();
    const refused = standIn(401);
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher: refused.fetcher,
      now: Date.now,
    });
    expect(await decode(playIntegrityToken())).toEqual({
      status: 'unavailable',
      reason: 'credential',
    });
    expect(await decode(playIntegrityToken())).toEqual({
      status: 'unavailable',
      reason: 'credential',
    });
    expect(refused.calls.filter(call => call.url === endpoints.tokenUri)).toHaveLength(2);
  });

  it('waits out a 429 without calling Google again until the cooldown ends', async () => {
    const { key } = await serviceAccount();
    let now = NOW;
    const decodes: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === endpoints.tokenUri) {
        return Response.json({ access_token: 'stand-in', expires_in: 3599 });
      }
      decodes.push(typeof init?.body === 'string' ? init.body : '');
      return decodes.length === 1
        ? Response.json({}, { status: 429, headers: { 'Retry-After': '30' } })
        : Response.json({ tokenPayloadExternal: rawVerdict() });
    };
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher,
      now: () => now,
    });
    const quota = { status: 'unavailable', reason: 'quota' };
    expect(await decode(playIntegrityToken())).toEqual(quota);
    now += 29_000;
    expect(await decode(playIntegrityToken())).toEqual(quota);
    expect(decodes).toHaveLength(1);
    now += 2_000;
    expect(await decode(playIntegrityToken())).toMatchObject({ status: 'decoded' });
    expect(decodes).toHaveLength(2);
  });

  it('shares one token exchange between concurrent cold decodes', async () => {
    const { key } = await serviceAccount();
    const { calls, fetcher } = standIn(200, { tokenPayloadExternal: rawVerdict() });
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher,
      now: Date.now,
    });
    await Promise.all([decode(playIntegrityToken()), decode(playIntegrityToken())]);
    expect(calls.filter(call => call.url === endpoints.tokenUri)).toHaveLength(1);
  });

  it('answers a failed token exchange as a credential failure and keeps no entry', async () => {
    const { key } = await serviceAccount();
    const calls: string[] = [];
    const fetcher: typeof fetch = async input => {
      calls.push(input instanceof Request ? input.url : input.toString());
      return new Response('nope', { status: 500 });
    };
    const decode = playIntegrityDecoder({
      key,
      packageName: PACKAGE,
      endpoints,
      fetcher,
      now: Date.now,
    });
    expect(await decode(playIntegrityToken())).toEqual({
      status: 'unavailable',
      reason: 'credential',
    });
    expect(await decode(playIntegrityToken())).toEqual({
      status: 'unavailable',
      reason: 'credential',
    });
    expect(calls).toEqual([endpoints.tokenUri, endpoints.tokenUri]);
  });
});
