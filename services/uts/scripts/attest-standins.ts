import { attestationChallengeInput } from '@kilocode/uts-contracts';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  BasicConstraints,
  Certificate,
  Extension,
  Extensions,
  Name,
  RelativeDistinguishedName,
  SubjectPublicKeyInfo,
  TBSCertificate,
  Validity,
  Version,
  id_ce_basicConstraints,
} from '@peculiar/asn1-x509';
import { Buffer } from 'node:buffer';
import { encode } from 'cbor2';

/**
 * Stand-ins for the platforms the attestation step talks to, in their real formats, for the unit
 * tests and the local end-to-end run (`scripts/attest-e2e.ts`): an App Attest certificate
 * authority and devices whose attestation objects and assertions have Apple's exact structure
 * (signed with keys made here, under a stand-in root), and Play Integrity verdicts shaped like
 * Google's `decodeIntegrityToken` answer. Nothing here is a real credential.
 */

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const ECDSA_SHA384 = '1.2.840.10045.4.3.3';
const NONCE_EXTENSION = '1.2.840.113635.100.8.2';
const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = async (bytes: Uint8Array | string) =>
  new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    )
  );

/** The attestation challenge of `code` (`@kilocode/uts-contracts` `attestation.ts`). */
export async function attestationChallenge(code: string): Promise<string> {
  return Buffer.from(await sha256(attestationChallengeInput(code))).toString('hex');
}

/** `SHA-256(UTF-8(challenge))`, what `attestKey`, `generateAssertion` and the request hash sign. */
export async function clientDataHashOf(code: string): Promise<Uint8Array> {
  return await sha256(await attestationChallenge(code));
}

/** The Play Integrity request hash the app sends for `code`. */
export async function playRequestHashOf(code: string): Promise<string> {
  return Buffer.from(await clientDataHashOf(code)).toString('base64');
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  if (length < 0x100) return [0x81, length];
  return [0x82, length >> 8, length & 0xff];
}

function der(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(contents);
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...derLength(body.length)]), body]));
}

/** WebCrypto's `r || s` as a DER `ECDSA-Sig-Value`, as X.509 and the Secure Enclave send it. */
export function rawToDerSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.subarray(start);
    return der(0x02, (trimmed[0] & 0x80) !== 0 ? new Uint8Array([0, ...trimmed]) : trimmed);
  };
  return der(0x30, integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

function name(commonName: string): Name {
  return new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: '2.5.4.3',
        value: new AttributeValue({ utf8String: commonName }),
      }),
    ]),
  ]);
}

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

async function ecKeyPair(curve: 'P-256' | 'P-384'): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ]);
  if (!('privateKey' in pair)) throw new Error('expected an ECDSA key pair');
  return pair;
}

/** A public key in a binary format (`spki` or `raw`). */
async function exportedBytes(format: 'spki' | 'raw', key: CryptoKey): Promise<Uint8Array> {
  const exported = await crypto.subtle.exportKey(format, key);
  if (!(exported instanceof ArrayBuffer)) throw new Error('expected binary key bytes');
  return new Uint8Array(exported);
}

async function certificate(input: {
  subject: string;
  issuer: string;
  subjectKey: CryptoKey;
  issuerKey: CryptoKey;
  issuerCurve: 'P-256' | 'P-384';
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  extensions?: Extension[];
}): Promise<Uint8Array> {
  const signatureOid = input.issuerCurve === 'P-384' ? ECDSA_SHA384 : ECDSA_SHA256;
  const algorithm = new AlgorithmIdentifier({ algorithm: signatureOid });
  const spki = AsnConvert.parse(
    await exportedBytes('spki', input.subjectKey),
    SubjectPublicKeyInfo
  );
  const extensions = [...(input.extensions ?? [])];
  if (input.ca) {
    extensions.push(
      new Extension({
        extnID: id_ce_basicConstraints,
        critical: true,
        extnValue: new OctetString(AsnConvert.serialize(new BasicConstraints({ cA: true }))),
      })
    );
  }
  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: crypto
      .getRandomValues(new Uint8Array(8))
      .map((byte, index) => (index === 0 ? byte & 0x7f : byte)).buffer,
    signature: algorithm,
    issuer: name(input.issuer),
    validity: new Validity({ notBefore: input.notBefore, notAfter: input.notAfter }),
    subject: name(input.subject),
    subjectPublicKeyInfo: spki,
    extensions: new Extensions(extensions),
  });
  const signed = AsnConvert.serialize(tbs);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: input.issuerCurve === 'P-384' ? 'SHA-384' : 'SHA-256' },
      input.issuerKey,
      signed
    )
  );
  const cert = new Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm: algorithm,
    signatureValue: rawToDerSignature(raw).slice().buffer,
  });
  return new Uint8Array(AsnConvert.serialize(cert));
}

/** A stand-in App Attest root and intermediate, both P-384 like Apple's. */
export type StandInAppAttestCa = {
  root: Uint8Array;
  intermediate: Uint8Array;
  intermediateKey: CryptoKey;
};

export async function standInAppAttestCa(now = Date.now()): Promise<StandInAppAttestCa> {
  const root = await ecKeyPair('P-384');
  const intermediate = await ecKeyPair('P-384');
  const rootDer = await certificate({
    subject: 'Stand-in App Attestation Root CA',
    issuer: 'Stand-in App Attestation Root CA',
    subjectKey: root.publicKey,
    issuerKey: root.privateKey,
    issuerCurve: 'P-384',
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 365 * DAY_MS),
    ca: true,
  });
  const intermediateDer = await certificate({
    subject: 'Stand-in App Attestation CA 1',
    issuer: 'Stand-in App Attestation Root CA',
    subjectKey: intermediate.publicKey,
    issuerKey: root.privateKey,
    issuerCurve: 'P-384',
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 365 * DAY_MS),
    ca: true,
  });
  return { root: rootDer, intermediate: intermediateDer, intermediateKey: intermediate.privateKey };
}

const AAGUIDS = {
  production: new Uint8Array([...new TextEncoder().encode('appattest'), 0, 0, 0, 0, 0, 0, 0]),
  development: new TextEncoder().encode('appattestdevelop'),
} as const;

/** What a device build can get wrong, for the refusal tests. */
export type DeviceFlaws = {
  appId?: string;
  environment?: keyof typeof AAGUIDS;
  /** The counter an assertion carries instead of the next one. */
  counter?: number;
};

/**
 * One app install: a Secure Enclave key stand-in, its key id (standard base64 of the SHA-256 of
 * the uncompressed point, as `generateKey` returns it), and Apple's attestation and assertion
 * formats.
 */
export type StandInAppAttestDevice = {
  keyId: string;
  attest(clientDataHash: Uint8Array): Promise<string>;
  assert(clientDataHash: Uint8Array, flaws?: DeviceFlaws): Promise<string>;
};

export async function standInAppAttestDevice(
  ca: StandInAppAttestCa,
  appId: string,
  flaws: DeviceFlaws = {}
): Promise<StandInAppAttestDevice> {
  const key = await ecKeyPair('P-256');
  const point = await exportedBytes('raw', key.publicKey);
  const keyIdBytes = await sha256(point);
  const rpIdHash = await sha256(flaws.appId ?? appId);
  let counter = 0;
  return {
    keyId: Buffer.from(keyIdBytes).toString('base64'),
    async attest(clientDataHash) {
      const coseKey = encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, point.subarray(1, 33)],
          [-3, point.subarray(33)],
        ])
      );
      const extensions = encode(
        new Map<string, string | Uint8Array>([
          ['apple_bundle_version_01', '1'],
          ['apple_validation_category_01', new Uint8Array([1, 0, 0, 0])],
        ])
      );
      const authData = new Uint8Array(
        Buffer.concat([
          rpIdHash,
          Buffer.from([0x40, 0, 0, 0, 0]),
          AAGUIDS[flaws.environment ?? 'production'],
          Buffer.from([0, 32]),
          keyIdBytes,
          coseKey,
          extensions,
        ])
      );
      const nonce = await sha256(new Uint8Array(Buffer.concat([authData, clientDataHash])));
      const now = Date.now();
      const leaf = await certificate({
        subject: Buffer.from(keyIdBytes).toString('hex'),
        issuer: 'Stand-in App Attestation CA 1',
        subjectKey: key.publicKey,
        issuerKey: ca.intermediateKey,
        issuerCurve: 'P-384',
        notBefore: new Date(now - DAY_MS),
        notAfter: new Date(now + 2 * DAY_MS),
        ca: false,
        extensions: [
          new Extension({
            extnID: NONCE_EXTENSION,
            critical: false,
            extnValue: new OctetString(der(0x30, der(0xa1, der(0x04, nonce))).slice().buffer),
          }),
        ],
      });
      const object = encode(
        new Map<string, unknown>([
          ['fmt', 'apple-appattest'],
          [
            'attStmt',
            new Map<string, unknown>([
              ['x5c', [leaf, ca.intermediate]],
              ['receipt', crypto.getRandomValues(new Uint8Array(64))],
            ]),
          ],
          ['authData', authData],
        ])
      );
      return Buffer.from(object).toString('base64');
    },
    async assert(clientDataHash, assertionFlaws = {}) {
      counter = assertionFlaws.counter ?? counter + 1;
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authenticatorData = new Uint8Array(
        Buffer.concat([
          await sha256(assertionFlaws.appId ?? flaws.appId ?? appId),
          Buffer.from([0]),
          counterBytes,
        ])
      );
      const nonce = await sha256(
        new Uint8Array(Buffer.concat([authenticatorData, clientDataHash]))
      );
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, nonce)
      );
      const object = encode(
        new Map<string, Uint8Array>([
          ['signature', rawToDerSignature(raw)],
          ['authenticatorData', authenticatorData],
        ])
      );
      return Buffer.from(object).toString('base64');
    },
  };
}

/** What a stand-in Play Integrity verdict says. */
export type PlayVerdictInput = {
  requestHash: string;
  packageName: string;
  certificateDigest: string;
  timestampMillis?: number;
  appRecognitionVerdict?: string;
  deviceRecognitionVerdict?: readonly string[];
};

/** A Play Integrity verdict as `decodeIntegrityToken` returns it (`tokenPayloadExternal`). */
export function playVerdict(input: PlayVerdictInput) {
  return {
    requestDetails: {
      requestPackageName: input.packageName,
      requestHash: input.requestHash,
      timestampMillis: String(input.timestampMillis ?? Date.now()),
    },
    appIntegrity: {
      appRecognitionVerdict: input.appRecognitionVerdict ?? 'PLAY_RECOGNIZED',
      packageName: input.packageName,
      certificateSha256Digest: [input.certificateDigest],
      versionCode: '42',
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: [...(input.deviceRecognitionVerdict ?? ['MEETS_DEVICE_INTEGRITY'])],
    },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    environmentDetails: { appAccessRiskVerdict: { appsDetected: ['KNOWN_INSTALLED'] } },
  };
}

/** A token shaped like a Play Integrity token (a compact JWE of random bytes). */
export function playIntegrityToken(): string {
  const part = (bytes: number) =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
  return `${part(32)}.${part(256)}.${part(12)}.${part(600)}.${part(16)}`;
}
