import { Buffer } from 'node:buffer';
import { encode } from 'cbor2';
import { describe, expect, it } from 'vitest';
import {
  APPLE_APP_ATTEST_ROOT,
  APPLE_APP_ATTEST_ROOT_SHA256,
  type AppAttestSettings,
  type KeyAttestationInput,
  verifyAssertion,
  verifyKeyAttestation,
} from '../../src/attest/app-attest';
import { appAttestNonce, ecdsaSignatureToRaw } from '../../src/attest/der';
import {
  type DeviceFlaws,
  rawToDerSignature,
  standInAppAttestCa,
  standInAppAttestDevice,
} from '../../scripts/attest-standins';

/**
 * The App Attest verifier against real Apple material and against stand-in devices that produce
 * Apple's exact formats.
 *
 * Real material: Apple's published attestation sample (Attestation Object Validation Guide, team
 * `1234567890`, bundle `com.example.myapp`, challenge `example_server_challenge`): its credential
 * certificate and authenticator data verbatim, issued by Apple's production intermediate "Apple App
 * Attestation CA 1" under the pinned root. The guide appends the challenge's bytes as the client
 * data, so the test passes them as the client data hash.
 */

const SAMPLE_LEAF = Buffer.from(
  'MIIEHTCCA6OgAwIBAgIGAZ2xPwtOMAoGCCqGSM49BAMCME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAx' +
    'MRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTI2MDQyMDE4MTMxMloXDTI2MDQyMzE4MTMx' +
    'MlowgZExSTBHBgNVBAMMQGNlMDQ5OGY1ODQ4M2ZiYjRkYTBkN2IyYzYzYTVhNTM4ZjU1MmQ0YWRjYjlhNGZhOTE2MTk1YzQ5' +
    'NjEzZTY1NWQxGjAYBgNVBAsMEUFBQSBDZXJ0aWZpY2F0aW9uMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxp' +
    'Zm9ybmlhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQzJUSs8yPbd0RDyq8zn1bn6VxyT6wsFCWfNl4kRWULK1+yhbz1Sb' +
    'y2BZRBLnaCokJ+6tqftS3+0LGrF+0J+pvaOCAiYwggIiMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgTwMBQGA1UdJQQN' +
    'MAsGCSqGSIb3Y2QEGDB6BgkqhkiG92NkCAUEbTBrpAMCAQq/iTADAgEAv4kxAwIBAL+JMgMCAQC/iTMDAgEAv4k0HgQcMTIz' +
    'NDU2Nzg5MC5jb20uZXhhbXBsZS5teWFwcL+JNgMCAQS/iTcDAgEAv4k5AwIBAL+JOgMCAQC/iTsDAgEAqgMCAQAwgeAGCSqG' +
    'SIb3Y2QIBwSB0jCBz7+KeAYEBDI3LjC/iFADAgECv4p5CQQHMS4wLjIxNr+KewkEBzI0QTMyNWK/inwGBAQyNy4wv4p9BgQE' +
    'MjcuML+KfgMCAQC/in8DAgEAv4sAAwIBAL+LAQMCAQC/iwIDAgEAv4sDAwIBAL+LBAMCAQG/iwUDAgEAv4sKEAQOMjQuMS4z' +
    'MjUuMC4yLDC/iwsQBA4yNC4xLjMyNS4wLjIsML+LDBAEDjI0LjEuMzI1LjAuMiwwv4gCCgQIaXBob25lb3O/iAUKBAhJbnRl' +
    'cm5hbDAzBgkqhkiG92NkCAIEJjAkoSIEIIe30G2TpClORvAR5mtsxADwurIHKZdsYZWAtCrmC/9uMFgGCSqGSIb3Y2QIBgRL' +
    'MEmjRwRFMEMMAjExMD0wCgwDb2tkoQMBAf8wCQwCb2GhAwEB/zALDARvc2duoQMBAf8wCwwEb2RlbKEDAQH/MAoMA29ja6ED' +
    'AQH/MAoGCCqGSM49BAMCA2gAMGUCMCG8x2j20SnJtrGuCbw1sk1+NMs/VNm8sRcU4aPhyDNB3mMBdxy8gNza6r91g8v1HQIx' +
    'AKTqMS+83kFdMob2rD3t9fnNWWLhA8RFOqw64XhXFTEWXqb1ddPoRcYCFlTEqULtPQ==',
  'base64'
);

const APPLE_INTERMEDIATE = Buffer.from(
  'MIICQzCCAcigAwIBAgIQCbrF4bxAGtnUU5W8OBoIVDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0' +
    'YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODM5NTVa' +
    'Fw0zMDAzMTMwMDAwMDBaME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAxMRMwEQYDVQQKDApBcHBsZSBJ' +
    'bmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAErls3oHdNebI1j0Dn0fImJvHCX+8XgC3q' +
    's4JqWYdP+NKtFSV4mqJmBBkSSLY8uWcGnpjTY71eNw+/oI4ynoBzqYXndG6jWaL2bynbMq9FXiEWWNVnr54mfrJhTcIaZs6Z' +
    'o2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFKyREFMzvb5oQf+nDKnl+url5YqhMB0GA1UdDgQWBBQ+410c' +
    'BBmpybQx+IR01uHhV3LjmzAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaQAwZgIxALu+iI1zjQUCz7z9Zm0JV1A1vNaH' +
    'LD+EMEkmKe3R+RToeZkcmui1rvjTqFQz97YNBgIxAKs47dDMge0ApFLDukT5k2NlU/7MKX8utN+fXr5aSsq2mVxLgg35BDhv' +
    'eAe7WJQ5tw==',
  'base64'
);

const SAMPLE_AUTH_DATA = Buffer.from(
  '9EZtaPketsEGIMt+Y8coMkRoXuHWRntUFg51MXIFfwNAAAAAAGFwcGF0dGVzdAAAAAAAAAAAIM4EmPWEg/u02g17LGOlpTj1' +
    'UtSty5pPqRYZXElhPmVdpQECAyYgASFYIEMyVErPMj23dEQ8qvM59W5+lcck+sLBQlnzZeJEVlCyIlggtfsoW89Um8tgWUQS' +
    '52gqJCfuran7Ut/tCxqxftCfqb2id2FwcGxlX2J1bmRsZV92ZXJzaW9uXzAxYTF4HGFwcGxlX3ZhbGlkYXRpb25fY2F0ZWdv' +
    'cnlfMDFEAQAAAA==',
  'base64'
);
const SAMPLE_CLIENT_DATA = new TextEncoder().encode('example_server_challenge');
const SAMPLE_KEY_ID = new Uint8Array(
  Buffer.from('zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=', 'base64')
);
/** Inside the sample credential certificate's validity (2026-04-20 to 2026-04-23). */
const SAMPLE_TIME = new Date('2026-04-21T12:00:00Z');

const SAMPLE_SETTINGS: AppAttestSettings = {
  appId: '1234567890.com.example.myapp',
  rootCertificate: APPLE_APP_ATTEST_ROOT,
  environments: ['production'],
};

function sampleAttestation(x5c: Uint8Array[] = [SAMPLE_LEAF, APPLE_INTERMEDIATE]): Uint8Array {
  return encode(
    new Map<string, unknown>([
      ['fmt', 'apple-appattest'],
      // CBOR byte strings come from plain Uint8Arrays, not Buffers, as on a device.
      [
        'attStmt',
        new Map<string, unknown>([
          ['x5c', x5c.map(entry => new Uint8Array(entry))],
          ['receipt', new Uint8Array(16)],
        ]),
      ],
      ['authData', new Uint8Array(SAMPLE_AUTH_DATA)],
    ])
  );
}

const sampleInput = (overrides: Partial<KeyAttestationInput> = {}): KeyAttestationInput => ({
  attestation: sampleAttestation(),
  keyId: SAMPLE_KEY_ID,
  clientDataHash: SAMPLE_CLIENT_DATA,
  now: SAMPLE_TIME,
  ...overrides,
});

describe('the pinned App Attest root', () => {
  it("is Apple's published root, by its SHA-256", async () => {
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', APPLE_APP_ATTEST_ROOT));
    expect(digest.toString('hex')).toBe(APPLE_APP_ATTEST_ROOT_SHA256);
  });
});

describe("Apple's published attestation sample", () => {
  it('verifies under the pinned root and returns the credential key', async () => {
    const result = await verifyKeyAttestation(sampleInput(), SAMPLE_SETTINGS);
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    // The last 65 bytes of the sample key's SubjectPublicKeyInfo, as the guide prints it.
    const spki = Buffer.from(
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQzJUSs8yPbd0RDyq8zn1bn6VxyT6wsFCWfNl4kRWULK1+yhbz1Sby2BZRBLnaCokJ+6tqftS3+0LGrF+0J+pvQ==',
      'base64'
    );
    expect(Buffer.from(result.publicKey)).toEqual(spki.subarray(spki.length - 65));
  });

  it('verifies with the root sent as the third certificate', async () => {
    const result = await verifyKeyAttestation(
      sampleInput({
        attestation: sampleAttestation([SAMPLE_LEAF, APPLE_INTERMEDIATE, APPLE_APP_ATTEST_ROOT]),
      }),
      SAMPLE_SETTINGS
    );
    expect(result.status).toBe('verified');
  });

  it.each([
    ['another challenge', { clientDataHash: new TextEncoder().encode('other') }, 'nonce_mismatch'],
    ['another key id', { keyId: new Uint8Array(32).fill(7) }, 'key_id_mismatch'],
    [
      'a time after the certificate',
      { now: new Date('2026-05-01T00:00:00Z') },
      'certificate_validity',
    ],
    [
      'a time before the certificate',
      { now: new Date('2026-04-01T00:00:00Z') },
      'certificate_validity',
    ],
    [
      'a chain without the intermediate',
      { attestation: sampleAttestation([SAMPLE_LEAF]) },
      'malformed',
    ],
    [
      'the leaf as its own issuer',
      { attestation: sampleAttestation([SAMPLE_LEAF, SAMPLE_LEAF]) },
      'certificate_chain',
    ],
    [
      'a root other than the pinned one as the third certificate',
      { attestation: sampleAttestation([SAMPLE_LEAF, APPLE_INTERMEDIATE, APPLE_INTERMEDIATE]) },
      'certificate_chain',
    ],
    ['bytes that are not CBOR', { attestation: new Uint8Array([0xff, 0x00, 0x13]) }, 'malformed'],
    ['a short key id', { keyId: new Uint8Array(16) }, 'malformed'],
  ])('is refused with %s', async (_name, overrides, reason) => {
    expect(await verifyKeyAttestation(sampleInput(overrides), SAMPLE_SETTINGS)).toEqual({
      status: 'refused',
      reason,
    });
  });

  it('is refused for another App ID', async () => {
    expect(
      await verifyKeyAttestation(sampleInput(), {
        ...SAMPLE_SETTINGS,
        appId: 'X96D76J65Z.com.kilocode.kiloapp',
      })
    ).toEqual({ status: 'refused', reason: 'app_id_mismatch' });
  });

  it('is refused where only the development App Attest environment is accepted', async () => {
    expect(
      await verifyKeyAttestation(sampleInput(), {
        ...SAMPLE_SETTINGS,
        environments: ['development'],
      })
    ).toEqual({ status: 'refused', reason: 'environment_mismatch' });
  });

  it('is refused under another root', async () => {
    const ca = await standInAppAttestCa();
    expect(
      await verifyKeyAttestation(sampleInput(), { ...SAMPLE_SETTINGS, rootCertificate: ca.root })
    ).toEqual({ status: 'refused', reason: 'certificate_chain' });
  });

  it('is refused when the authenticator data carries a trailing byte', async () => {
    const attestation = encode(
      new Map<string, unknown>([
        ['fmt', 'apple-appattest'],
        [
          'attStmt',
          new Map<string, unknown>([
            ['x5c', [new Uint8Array(SAMPLE_LEAF), new Uint8Array(APPLE_INTERMEDIATE)]],
          ]),
        ],
        ['authData', new Uint8Array([...SAMPLE_AUTH_DATA, 0])],
      ])
    );
    // The nonce covers every byte, so a changed authenticator data fails there first.
    expect(await verifyKeyAttestation(sampleInput({ attestation }), SAMPLE_SETTINGS)).toEqual({
      status: 'refused',
      reason: 'nonce_mismatch',
    });
  });
});

describe('a stand-in device', () => {
  const appId = 'ABCDE12345.com.example.kilo';

  async function setup(flaws: DeviceFlaws = {}) {
    const ca = await standInAppAttestCa();
    const device = await standInAppAttestDevice(ca, appId, flaws);
    const settings: AppAttestSettings = {
      appId,
      rootCertificate: ca.root,
      environments: ['production'],
    };
    return { ca, device, settings };
  }

  const clientDataHash = crypto.getRandomValues(new Uint8Array(32));

  async function attested(flaws: DeviceFlaws = {}) {
    const { device, settings } = await setup(flaws);
    const result = await verifyKeyAttestation(
      {
        attestation: new Uint8Array(Buffer.from(await device.attest(clientDataHash), 'base64')),
        keyId: new Uint8Array(Buffer.from(device.keyId, 'base64')),
        clientDataHash,
        now: new Date(),
      },
      settings
    );
    return { device, settings, result };
  }

  it('attests a key and signs assertions with a growing counter', async () => {
    const { device, settings, result } = await attested();
    if (result.status !== 'verified') throw new Error(`refused: ${result.reason}`);
    const first = await verifyAssertion(
      {
        assertion: new Uint8Array(Buffer.from(await device.assert(clientDataHash), 'base64')),
        publicKey: result.publicKey,
        clientDataHash,
      },
      settings
    );
    const second = await verifyAssertion(
      {
        assertion: new Uint8Array(Buffer.from(await device.assert(clientDataHash), 'base64')),
        publicKey: result.publicKey,
        clientDataHash,
      },
      settings
    );
    expect([first, second]).toEqual([
      { status: 'verified', signCount: 1 },
      { status: 'verified', signCount: 2 },
    ]);
  });

  it('refuses an attestation from a development build where production is required', async () => {
    const { result } = await attested({ environment: 'development' });
    expect(result).toEqual({ status: 'refused', reason: 'environment_mismatch' });
  });

  it('refuses an attestation for another App ID', async () => {
    const { result } = await attested({ appId: 'ABCDE12345.com.example.other' });
    expect(result).toEqual({ status: 'refused', reason: 'app_id_mismatch' });
  });

  it('refuses an assertion over other client data, for another App ID, or by another key', async () => {
    const { device, settings, result } = await attested();
    if (result.status !== 'verified') throw new Error(`refused: ${result.reason}`);
    const other = await setup();
    const assertion = async (signer = device, flaws = {}) =>
      new Uint8Array(Buffer.from(await signer.assert(clientDataHash, flaws), 'base64'));
    const verifyWith = async (bytes: Uint8Array, data = clientDataHash) =>
      verifyAssertion(
        { assertion: bytes, publicKey: result.publicKey, clientDataHash: data },
        settings
      );
    expect(await verifyWith(await assertion(), new Uint8Array(32))).toEqual({
      status: 'refused',
      reason: 'signature_invalid',
    });
    expect(
      await verifyWith(await assertion(device, { appId: 'ABCDE12345.com.example.other' }))
    ).toEqual({
      status: 'refused',
      reason: 'app_id_mismatch',
    });
    expect(await verifyWith(await assertion(other.device))).toEqual({
      status: 'refused',
      reason: 'signature_invalid',
    });
    expect(await verifyWith(encode(new Map([['signature', new Uint8Array(8)]])))).toEqual({
      status: 'refused',
      reason: 'malformed',
    });
  });
});

describe('DER reads', () => {
  it("read the sample certificate's nonce extension shape and nothing else", () => {
    const nonce = new Uint8Array(32).fill(9);
    const value = new Uint8Array([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20, ...nonce]);
    expect(appAttestNonce(value)).toEqual(nonce);
    expect(appAttestNonce(new Uint8Array([...value, 0]))).toBeNull();
    expect(appAttestNonce(new Uint8Array([0x30, 0x22, 0x04, 0x20, ...nonce]))).toBeNull();
  });

  it('turn a DER ECDSA signature into r || s and back', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[31] = 1;
    raw[63] = 2;
    const derSignature = rawToDerSignature(raw);
    expect(ecdsaSignatureToRaw(derSignature, 32)).toEqual(raw);
    // A negative or over-long integer, or a trailing byte, is refused.
    expect(
      ecdsaSignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]), 32)
    ).toBeNull();
    expect(ecdsaSignatureToRaw(new Uint8Array([...derSignature, 0]), 32)).toBeNull();
    expect(ecdsaSignatureToRaw(derSignature, 16)).toBeNull();
  });
});
