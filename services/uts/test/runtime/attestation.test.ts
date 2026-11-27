import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { AttestationSettings } from '../../src/attest/config';
import type { AttestationGateDeps, AttestationService } from '../../src/attest/gate';
import type { PlayDecode } from '../../src/attest/play-integrity';
import type {
  AttestationAccess,
  AttestationStore,
  ClaimInput,
  ClaimResult,
  SettleInput,
  SettleOutcome,
} from '../../src/attest/store';
import { type OAuthDeps, handleOAuthRequest } from '../../src/oauth/routes';
import { randomCredential, sha256 } from '../../src/token/credentials';
import {
  clientDataHashOf,
  playIntegrityToken,
  playRequestHashOf,
  playVerdict,
  standInAppAttestCa,
  standInAppAttestDevice,
} from '../../scripts/attest-standins';
import {
  dpopKey,
  dpopProof,
  errorOf,
  fakeGrants,
  formRequest,
  minted,
  oauthDeps,
} from './oauth-support';
import { config } from './test-env';

/**
 * The attestation step of the `kilo-mobile` code exchange and the authorization endpoint's
 * refusal, through the OAuth routes with a recording attestation store, stand-in App Attest
 * devices and a stand-in Play Integrity decode.
 */

const MOBILE_REDIRECT = 'com.kilocode.kiloapp:/oauth/callback';
const PACKAGE = 'com.example.kilo';
const APP_ID = 'ABCDE12345.com.example.kilo';
const DIGEST = new Uint8Array(32).fill(0x5a);
const MOBILE_SCOPE = 'notifications:badges.read';

async function call(request: Request, deps: OAuthDeps) {
  const response = await handleOAuthRequest(request, new URL(request.url).pathname, deps);
  if (response === null) throw new Error('not an OAuth path');
  return response;
}

/** A store that answers claims with `claim` and records every statement. */
function recordingStore(
  claim: (input: ClaimInput) => ClaimResult,
  settle: SettleOutcome = 'attested'
) {
  const claims: ClaimInput[] = [];
  const settles: SettleInput[] = [];
  const store: AttestationStore = {
    async claim(input) {
      claims.push(input);
      return claim(input);
    },
    async settle(input) {
      settles.push(input);
      return input.result.kind === 'released' ? 'released' : settle;
    },
    async exempt() {
      throw new Error('unexpected exempt');
    },
  };
  const access: AttestationAccess = work => work(store);
  return { access, claims, settles };
}

async function service(
  store: AttestationAccess,
  decode: PlayDecode = async () => {
    throw new Error('unexpected decode');
  }
) {
  const ca = await standInAppAttestCa();
  const settings: AttestationSettings = {
    appAttest: { appId: APP_ID, rootCertificate: ca.root, environments: ['production'] },
    play: {
      key: { clientEmail: 'sa@example.com', privateKeyId: 'c'.repeat(40), privateKeyPem: '' },
      endpoints: { tokenUri: 'http://127.0.0.1:9/token', apiBase: 'http://127.0.0.1:9/v1' },
      expectation: { packageName: PACKAGE, certificateDigests: [DIGEST] },
    },
  };
  const gate: AttestationGateDeps = {
    environment: config.environment,
    settings,
    decode,
    store,
    inFlight: new Set(),
    now: Date.now,
  };
  const attestation: AttestationService = { kind: 'verified', gate };
  return { ca, attestation, gate };
}

function issuingGrants() {
  return fakeGrants({
    exchangeCode: async () => ({
      outcome: 'issued',
      refreshExpiresAt: new Date(Date.now() + 60 * 86_400_000),
      ...minted({ scopes: [MOBILE_SCOPE] }),
    }),
  });
}

async function exchangeRequest(code: string, attestation: Record<string, string> = {}) {
  return formRequest(
    '/token',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: MOBILE_REDIRECT,
      client_id: 'kilo-mobile',
      code_verifier: randomCredential(),
      ...attestation,
    },
    { DPoP: await dpopProof(await dpopKey()) }
  );
}

describe('authorization endpoint', () => {
  const authorize = new Request(
    `${config.endpoints.issuer}/authorize?${new URLSearchParams({
      client_id: 'kilo-mobile',
      redirect_uri: MOBILE_REDIRECT,
      response_type: 'code',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      scope: MOBILE_SCOPE,
      dpop_jkt: Buffer.alloc(32, 3).toString('base64url'),
    }).toString()}`
  );

  it('refuses kilo-mobile, before any hand-off, where attestation is not configured', async () => {
    const response = await call(
      authorize,
      oauthDeps(fakeGrants().access, { attestation: { kind: 'refused', problems: [] } })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('unauthorized_client');
  });

  it('refuses kilo-mobile where the config is incomplete, naming no value', async () => {
    const response = await call(
      authorize,
      oauthDeps(fakeGrants().access, {
        attestation: { kind: 'refused', problems: ['ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY'] },
      })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('unauthorized_client');
  });

  it('hands kilo-mobile to the sign-in where attestation is verified', async () => {
    const store = recordingStore(() => ({ outcome: 'invalid_grant' }));
    const { attestation } = await service(store.access);
    let handedOff = false;
    const response = await call(
      authorize,
      oauthDeps(fakeGrants().access, {
        attestation,
        handoff: async () => {
          handedOff = true;
          return { status: 'interaction', response: new Response('sign in', { status: 200 }) };
        },
      })
    );
    expect(response.status).toBe(200);
    expect(handedOff).toBe(true);
  });
});

describe('token endpoint: kilo-mobile code exchange', () => {
  it('refuses the exchange where attestation is not configured', async () => {
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(randomCredential()),
      oauthDeps(grants.access, { attestation: { kind: 'refused', problems: [] } })
    );
    expect(await errorOf(response)).toBe('unauthorized_client');
    expect(grants.calls).toEqual([]);
  });

  it('asks for an attestation when the request carries none and the code has none', async () => {
    const store = recordingStore(() => ({ outcome: 'proof_required' }));
    const { attestation } = await service(store.access);
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(randomCredential()),
      oauthDeps(grants.access, { attestation })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('attestation_required');
    expect(store.claims[0].proof).toBeNull();
    expect(grants.calls).toEqual([]);
  });

  it('attests a new App Attest key, stores it, then exchanges the code', async () => {
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }));
    const { ca, attestation } = await service(store.access);
    const device = await standInAppAttestDevice(ca, APP_ID);
    const code = randomCredential();
    const grants = issuingGrants();
    const response = await call(
      await exchangeRequest(code, {
        attestation_type: 'app_attest_key',
        attestation_key_id: device.keyId,
        attestation: await device.attest(await clientDataHashOf(code)),
      }),
      oauthDeps(grants.access, { attestation })
    );
    expect(response.status).toBe(200);
    expect(store.claims).toHaveLength(1);
    expect(Buffer.from(store.claims[0].codeHash)).toEqual(Buffer.from(await sha256(code)));
    expect(store.claims[0].proof?.type).toBe('app_attest_key');
    expect(store.settles).toHaveLength(1);
    expect(store.settles[0].result).toMatchObject({ kind: 'attested', signCount: null });
    expect(grants.calls.map(call => call.method)).toEqual(['exchangeCode']);
  });

  it('verifies an assertion with the stored key and settles its counter', async () => {
    const ca = await standInAppAttestCa();
    const device = await standInAppAttestDevice(ca, APP_ID);
    const attestCode = randomCredential();
    // Register the key through a first exchange to learn its point.
    const first = recordingStore(() => ({ outcome: 'claimed', storedKey: null }));
    const firstService = await service(first.access);
    firstService.gate.settings.appAttest.rootCertificate = ca.root;
    await call(
      await exchangeRequest(attestCode, {
        attestation_type: 'app_attest_key',
        attestation_key_id: device.keyId,
        attestation: await device.attest(await clientDataHashOf(attestCode)),
      }),
      oauthDeps(issuingGrants().access, { attestation: firstService.attestation })
    );
    const registered = first.settles[0].result;
    if (registered.kind !== 'attested' || registered.publicKey === null) {
      throw new Error('the key was not attested');
    }
    const publicKey = registered.publicKey;

    const store = recordingStore(() => ({
      outcome: 'claimed',
      storedKey: { publicKey, signCount: 0 },
    }));
    const { attestation, gate } = await service(store.access);
    gate.settings.appAttest.rootCertificate = ca.root;
    const code = randomCredential();
    const response = await call(
      await exchangeRequest(code, {
        attestation_type: 'app_attest_assertion',
        attestation_key_id: device.keyId,
        attestation: await device.assert(await clientDataHashOf(code)),
      }),
      oauthDeps(issuingGrants().access, { attestation })
    );
    expect(response.status).toBe(200);
    expect(store.settles[0].result).toEqual({ kind: 'attested', publicKey: null, signCount: 1 });

    // The same assertion for another code signs other client data: refused, code dead.
    const replay = recordingStore(
      () => ({ outcome: 'claimed', storedKey: { publicKey, signCount: 1 } }),
      'refused'
    );
    const replayService = await service(replay.access);
    replayService.gate.settings.appAttest.rootCertificate = ca.root;
    const grants = fakeGrants();
    const replayed = await call(
      await exchangeRequest(randomCredential(), {
        attestation_type: 'app_attest_assertion',
        attestation_key_id: device.keyId,
        attestation: await device.assert(await clientDataHashOf(code)),
      }),
      oauthDeps(grants.access, { attestation: replayService.attestation })
    );
    expect(await errorOf(replayed)).toBe('invalid_grant');
    expect(replay.settles[0].result).toEqual({ kind: 'refused', reason: 'signature_invalid' });
    expect(grants.calls).toEqual([]);
  });

  it('asks for a new key when the assertion names a key the store does not hold', async () => {
    const store = recordingStore(() => ({ outcome: 'unknown_key' }));
    const { ca, attestation } = await service(store.access);
    const device = await standInAppAttestDevice(ca, APP_ID);
    const code = randomCredential();
    const response = await call(
      await exchangeRequest(code, {
        attestation_type: 'app_attest_assertion',
        attestation_key_id: device.keyId,
        attestation: await device.assert(await clientDataHashOf(code)),
      }),
      oauthDeps(fakeGrants().access, { attestation })
    );
    expect(await errorOf(response)).toBe('attestation_required');
    expect(store.settles).toEqual([]);
  });

  it('decodes a Play Integrity token once, checks the verdict and exchanges', async () => {
    const code = randomCredential();
    const requestHash = await playRequestHashOf(code);
    const decoded: string[] = [];
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }));
    const { attestation } = await service(store.access, async token => {
      decoded.push(token);
      return {
        status: 'decoded',
        verdict: {
          ...playVerdict({
            requestHash,
            packageName: PACKAGE,
            certificateDigest: Buffer.from(DIGEST).toString('base64url'),
          }),
          requestDetails: { requestPackageName: PACKAGE, requestHash, timestampMillis: Date.now() },
        },
      };
    });
    const token = playIntegrityToken();
    const grants = issuingGrants();
    const response = await call(
      await exchangeRequest(code, { attestation_type: 'play_integrity', attestation: token }),
      oauthDeps(grants.access, { attestation })
    );
    expect(response.status).toBe(200);
    expect(decoded).toEqual([token]);
    expect(store.claims[0].proof).toEqual({ type: 'play_integrity', keyId: null });
    expect(store.settles[0].result).toEqual({ kind: 'attested', publicKey: null, signCount: null });
  });

  it('refuses a Play Integrity verdict for another package and never exchanges', async () => {
    const code = randomCredential();
    const requestHash = await playRequestHashOf(code);
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }), 'refused');
    const { attestation } = await service(store.access, async () => ({
      status: 'decoded',
      verdict: {
        ...playVerdict({
          requestHash,
          packageName: 'com.example.repackaged',
          certificateDigest: Buffer.from(DIGEST).toString('base64url'),
        }),
        requestDetails: {
          requestPackageName: 'com.example.repackaged',
          requestHash,
          timestampMillis: Date.now(),
        },
      },
    }));
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(code, {
        attestation_type: 'play_integrity',
        attestation: playIntegrityToken(),
      }),
      oauthDeps(grants.access, { attestation })
    );
    expect(await errorOf(response)).toBe('invalid_grant');
    expect(store.settles[0].result).toEqual({ kind: 'refused', reason: 'package_mismatch' });
    expect(grants.calls).toEqual([]);
  });

  it('releases the claim when Google is unavailable, so a retry can verify again', async () => {
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }));
    const { attestation } = await service(store.access, async () => ({
      status: 'unavailable',
      reason: 'quota',
    }));
    const response = await call(
      await exchangeRequest(randomCredential(), {
        attestation_type: 'play_integrity',
        attestation: playIntegrityToken(),
      }),
      oauthDeps(fakeGrants().access, { attestation })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(store.settles[0].result).toEqual({ kind: 'released' });
  });

  it('exchanges an attested code again without a second verification', async () => {
    const decodes: string[] = [];
    const store = recordingStore(() => ({ outcome: 'attested' }));
    const { attestation } = await service(store.access, async token => {
      decodes.push(token);
      return { status: 'invalid_token' };
    });
    const grants = issuingGrants();
    const response = await call(
      await exchangeRequest(randomCredential(), {
        attestation_type: 'play_integrity',
        attestation: playIntegrityToken(),
      }),
      oauthDeps(grants.access, { attestation })
    );
    expect(response.status).toBe(200);
    expect(decodes).toEqual([]);
    expect(store.settles).toEqual([]);
  });

  it('leaves a reused code to the exchange statement, which revokes its grant', async () => {
    const store = recordingStore(() => ({ outcome: 'reused' }));
    const { attestation } = await service(store.access);
    const grants = fakeGrants({
      exchangeCode: async () => ({ outcome: 'invalid_grant', feedEntries: [] }),
    });
    const response = await call(
      await exchangeRequest(randomCredential()),
      oauthDeps(grants.access, { attestation })
    );
    expect(await errorOf(response)).toBe('invalid_grant');
    expect(grants.calls.map(call => call.method)).toEqual(['exchangeCode']);
  });

  it.each([
    ['busy', 503],
    ['refused', 400],
    ['invalid_grant', 400],
  ] as const)('answers a %s claim without verifying or exchanging', async (outcome, status) => {
    const store = recordingStore(() => ({ outcome }));
    const { attestation } = await service(store.access);
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(randomCredential(), {
        attestation_type: 'play_integrity',
        attestation: playIntegrityToken(),
      }),
      oauthDeps(grants.access, { attestation })
    );
    expect(response.status).toBe(status);
    expect(store.settles).toEqual([]);
    expect(grants.calls).toEqual([]);
  });

  it.each([
    ['an unknown type', { attestation_type: 'safetynet', attestation: 'abc' }],
    [
      'a key id on a Play token',
      {
        attestation_type: 'play_integrity',
        attestation: playIntegrityToken(),
        attestation_key_id: 'AAAA',
      },
    ],
    [
      'no key id on an assertion',
      { attestation_type: 'app_attest_assertion', attestation: 'AAAA' },
    ],
    [
      'a short key id',
      { attestation_type: 'app_attest_key', attestation: 'AAAA', attestation_key_id: 'AAAA' },
    ],
    [
      'a value that is not base64',
      {
        attestation_type: 'app_attest_key',
        attestation: '***',
        attestation_key_id: Buffer.alloc(32).toString('base64'),
      },
    ],
    [
      'a value over 16 KiB',
      { attestation_type: 'play_integrity', attestation: `${'a'.repeat(16 * 1024)}.b.c.d.e` },
    ],
    ['a type without a value', { attestation_type: 'play_integrity' }],
  ])('refuses %s before any statement', async (_name, fields) => {
    const store = recordingStore(() => {
      throw new Error('unexpected claim');
    });
    const { attestation } = await service(store.access);
    const response = await call(
      await exchangeRequest(randomCredential(), fields),
      oauthDeps(fakeGrants().access, { attestation })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_request');
    expect(store.claims).toEqual([]);
  });

  it('asks for a new key when the attested key is stored already, and keeps the code', async () => {
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }), 'key_known');
    const { ca, attestation, gate } = await service(store.access);
    gate.settings.appAttest.rootCertificate = ca.root;
    const device = await standInAppAttestDevice(ca, APP_ID);
    const code = randomCredential();
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(code, {
        attestation_type: 'app_attest_key',
        attestation_key_id: device.keyId,
        attestation: await device.attest(await clientDataHashOf(code)),
      }),
      oauthDeps(grants.access, { attestation })
    );
    expect(await errorOf(response)).toBe('attestation_required');
    expect(store.settles[0].result).toMatchObject({ kind: 'attested' });
    expect(grants.calls).toEqual([]);
  });

  it('hands any printable base64url-and-dots token to Google, which decides', async () => {
    const decoded: string[] = [];
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }), 'refused');
    const { attestation } = await service(store.access, async token => {
      decoded.push(token);
      return { status: 'invalid_token' };
    });
    const response = await call(
      await exchangeRequest(randomCredential(), {
        attestation_type: 'play_integrity',
        attestation: 'abc.def',
      }),
      oauthDeps(fakeGrants().access, { attestation })
    );
    expect(await errorOf(response)).toBe('invalid_grant');
    expect(decoded).toEqual(['abc.def']);
    expect(store.settles[0].result).toEqual({ kind: 'refused', reason: 'token_invalid' });
  });

  it('answers the original error when verification throws, also when the release fails', async () => {
    const claims: ClaimInput[] = [];
    const failing: AttestationAccess = work =>
      work({
        async claim(input) {
          claims.push(input);
          return { outcome: 'claimed', storedKey: null };
        },
        async settle() {
          throw new Error('the store is down');
        },
        async exempt() {
          throw new Error('unexpected exempt');
        },
      });
    const { attestation } = await service(failing, async () => {
      throw new TypeError('decode crashed');
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      const response = await call(
        await exchangeRequest(randomCredential(), {
          attestation_type: 'play_integrity',
          attestation: playIntegrityToken(),
        }),
        oauthDeps(fakeGrants().access, { attestation })
      );
      expect(response.status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(claims).toHaveLength(1);
    expect(errors.some(line => line.includes('uts.attestation.release_failed'))).toBe(true);
    expect(errors.some(line => line.includes('"error":"TypeError"'))).toBe(true);
  });

  it('marks the code exempt before the exchange in development without config', async () => {
    const exempted: Uint8Array[] = [];
    const store: AttestationAccess = work =>
      work({
        claim: async () => {
          throw new Error('unexpected claim');
        },
        settle: async () => {
          throw new Error('unexpected settle');
        },
        exempt: async input => {
          exempted.push(input.codeHash);
        },
      });
    const code = randomCredential();
    const grants = issuingGrants();
    const response = await call(
      await exchangeRequest(code),
      oauthDeps(grants.access, { attestation: { kind: 'unattested_development', store } })
    );
    expect(response.status).toBe(200);
    expect(exempted.map(hash => Buffer.from(hash))).toEqual([Buffer.from(await sha256(code))]);
  });

  it('refuses a second request for a code this isolate verifies now', async () => {
    const held = Promise.withResolvers<void>();
    const decoding = Promise.withResolvers<void>();
    const store = recordingStore(() => ({ outcome: 'claimed', storedKey: null }), 'refused');
    const { attestation } = await service(store.access, async () => {
      decoding.resolve();
      await held.promise;
      return { status: 'invalid_token' };
    });
    const code = randomCredential();
    const fields = { attestation_type: 'play_integrity', attestation: playIntegrityToken() };
    const first = call(
      await exchangeRequest(code, fields),
      oauthDeps(fakeGrants().access, { attestation })
    );
    await decoding.promise;
    const second = await call(
      await exchangeRequest(code, fields),
      oauthDeps(fakeGrants().access, { attestation })
    );
    expect(second.status).toBe(503);
    held.resolve();
    expect((await first).status).toBe(400);
    expect(store.claims).toHaveLength(1);
  });
});
