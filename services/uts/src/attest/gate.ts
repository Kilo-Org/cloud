import {
  UTS_ATTESTATION_PARAMS,
  UTS_MAX_ATTESTATION_CHARS,
  UtsAttestationTypeSchema,
  type UtsEnvironment,
  attestationChallengeInput,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import type { UtsConfig } from '../env';
import type { UtsSecrets } from '../secrets';
import { oauthError, temporarilyUnavailable } from '../oauth/errors';
import type { Params } from '../oauth/params';
import { verifyAssertion, verifyKeyAttestation } from './app-attest';
import {
  ATTEST_VAR_NAMES,
  type AttestEnv,
  type AttestProblem,
  type AttestationSettings,
  attestationPolicy,
  readAttestationConfig,
} from './config';
import { type PlayDecode, checkPlayVerdict, playIntegrityDecoder } from './play-integrity';
import type { AttestationAccess, SettleInput } from './store';

/**
 * The attestation step of a `kilo-mobile` code exchange (design 5.5, decision Q67), between the
 * DPoP check and the exchange statement:
 *
 * 1. Read the attestation parameters; a malformed one ends the request before any statement.
 * 2. Claim the code's attestation (`uts.claim_code_attestation`), which first checks the code
 *    against the request, so a request without a valid code reaches no verifier and no Google
 *    call. An attested code skips the verification: an exchange retry decodes nothing again.
 * 3. Verify: App Attest in the Worker; Play Integrity through one `decodeIntegrityToken` call.
 * 4. Settle the claim (`uts.settle_code_attestation`): attested, refused (the code is then
 *    dead), or released after a retryable failure.
 *
 * Within an isolate a second request for the same code waits for nothing: it is refused before
 * its first await while the first one verifies, and across isolates the claim does the same.
 */

export type AttestationGateDeps = {
  environment: UtsEnvironment;
  settings: AttestationSettings;
  decode: PlayDecode;
  store: AttestationAccess;
  /** The codes whose attestation this isolate verifies now. */
  inFlight: Set<string>;
  now: () => number;
};

/**
 * `unattested_development` carries the store for the exempt statement, which the exchange
 * statement's backstop needs before it consumes the code (migration 0017). `unavailable`: the
 * attestation key could not be read from STS; the code exchange answers a retryable 503.
 */
export type AttestationService =
  | { kind: 'refused'; problems: readonly AttestProblem[] }
  | { kind: 'unattested_development'; store: AttestationAccess }
  | { kind: 'unavailable' }
  | { kind: 'verified'; gate: AttestationGateDeps };

/** Codes in verification, per isolate. */
const inFlight = new Set<string>();

type IsolatePolicy =
  | { kind: 'refused'; problems: readonly AttestProblem[] }
  | { kind: 'unattested_development' }
  | { kind: 'unavailable' }
  | { kind: 'verified'; settings: AttestationSettings; decode: PlayDecode };

/**
 * The policy and its decode port, per isolate, for the raw attestation values they came from: the
 * config (a JSON key file and a digest list) is parsed once, not per request.
 */
let isolatePolicy: { key: string; policy: IsolatePolicy } | null = null;

function policyOf(env: AttestEnv, secrets: UtsSecrets, environment: UtsEnvironment): IsolatePolicy {
  const key = JSON.stringify([
    environment,
    ...ATTEST_VAR_NAMES.map(name => env[name] ?? null),
    secrets.status === 'read'
      ? (secrets.values.ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY ?? null)
      : { unavailable: true },
  ]);
  if (isolatePolicy?.key === key) return isolatePolicy.policy;
  const policy = attestationPolicy(readAttestationConfig(env, secrets, environment), environment);
  let resolved: IsolatePolicy;
  if (policy.kind === 'verified') {
    const { play } = policy.settings;
    resolved = {
      kind: 'verified',
      settings: policy.settings,
      decode: playIntegrityDecoder({
        key: play.key,
        packageName: play.expectation.packageName,
        endpoints: play.endpoints,
        fetcher: (url, init) => fetch(url, init),
        now: Date.now,
      }),
    };
  } else {
    resolved = policy;
  }
  isolatePolicy = { key, policy: resolved };
  return resolved;
}

/** The attestation service of an environment whose identity store is bound. */
export function attestationService(
  env: AttestEnv,
  secrets: UtsSecrets,
  config: UtsConfig,
  store: AttestationAccess
): AttestationService {
  const policy = policyOf(env, secrets, config.environment);
  if (policy.kind === 'refused' || policy.kind === 'unavailable') return policy;
  if (policy.kind === 'unattested_development') return { kind: 'unattested_development', store };
  return {
    kind: 'verified',
    gate: {
      environment: config.environment,
      settings: policy.settings,
      decode: policy.decode,
      store,
      inFlight,
      now: Date.now,
    },
  };
}

type Proof =
  | { type: 'app_attest_key'; keyId: Uint8Array; payload: Uint8Array }
  | { type: 'app_attest_assertion'; keyId: Uint8Array; payload: Uint8Array }
  | { type: 'play_integrity'; token: string };

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
/**
 * A Play Integrity token is opaque to UTS: printable base64url characters, dots and padding,
 * within the size limit; `decodeIntegrityToken` decides whether it is one.
 */
const INTEGRITY_TOKEN = /^[A-Za-z0-9_.=-]+$/;
const KEY_ID_BYTES = 32;

function malformed(): Response {
  return oauthError('invalid_request', 400, 'the attestation parameters are malformed');
}

/** The attestation the request carries; null when it carries none. */
function readProof(params: Params): Proof | null | Response {
  const type = params.one(UTS_ATTESTATION_PARAMS.type);
  const proof = params.one(UTS_ATTESTATION_PARAMS.proof);
  const keyId = params.one(UTS_ATTESTATION_PARAMS.keyId);
  if (type.status === 'absent' && proof.status === 'absent' && keyId.status === 'absent') {
    return null;
  }
  const kind = UtsAttestationTypeSchema.safeParse(type.status === 'present' ? type.value : null);
  if (
    !kind.success ||
    proof.status !== 'present' ||
    proof.value.length > UTS_MAX_ATTESTATION_CHARS ||
    keyId.status === 'repeated'
  ) {
    return malformed();
  }
  if (kind.data === 'play_integrity') {
    if (keyId.status !== 'absent' || !INTEGRITY_TOKEN.test(proof.value)) return malformed();
    return { type: 'play_integrity', token: proof.value };
  }
  if (keyId.status !== 'present' || !BASE64.test(keyId.value) || !BASE64.test(proof.value)) {
    return malformed();
  }
  const keyIdBytes = new Uint8Array(Buffer.from(keyId.value, 'base64'));
  const payload = new Uint8Array(Buffer.from(proof.value, 'base64'));
  if (keyIdBytes.length !== KEY_ID_BYTES || payload.length === 0) return malformed();
  return { type: kind.data, keyId: keyIdBytes, payload };
}

/** The code exchange the attestation is bound to, as the token request and its proof name it. */
export type AttestedCode = {
  code: string;
  codeHash: Uint8Array;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  dpopJkt: Uint8Array;
};

/** `exchange`: run the exchange statement; otherwise the answer. */
export type GateOutcome = { status: 'exchange' } | Response;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * The challenge (lowercase hex, Play Integrity's request hash as is) and `SHA-256(UTF-8(challenge))`
 * (App Attest's client data hash).
 */
async function challengeOf(
  code: string
): Promise<{ challenge: string; clientDataHash: Uint8Array }> {
  const encoder = new TextEncoder();
  const challenge = Buffer.from(
    await sha256(encoder.encode(attestationChallengeInput(code)))
  ).toString('hex');
  return { challenge, clientDataHash: await sha256(encoder.encode(challenge)) };
}

const ATTESTATION_REQUIRED =
  'a device attestation over this code is required; attest a new App Attest key if the stored one is unknown';

/** Verifies the proof; never throws for anything the client sent. */
async function verify(
  proof: Proof,
  storedKey: { publicKey: Uint8Array; signCount: number } | null,
  code: string,
  deps: AttestationGateDeps
): Promise<SettleInput['result']> {
  const { challenge, clientDataHash } = await challengeOf(code);
  if (proof.type === 'app_attest_key') {
    const result = await verifyKeyAttestation(
      {
        attestation: proof.payload,
        keyId: proof.keyId,
        clientDataHash,
        now: new Date(deps.now()),
      },
      deps.settings.appAttest
    );
    return result.status === 'verified'
      ? { kind: 'attested', publicKey: result.publicKey, signCount: null }
      : { kind: 'refused', reason: result.reason };
  }
  if (proof.type === 'app_attest_assertion') {
    // The claim returns the stored key for every assertion it claims (migration 0017).
    if (storedKey === null) throw new Error('an assertion claim came without its stored key');
    const result = await verifyAssertion(
      { assertion: proof.payload, publicKey: storedKey.publicKey, clientDataHash },
      deps.settings.appAttest
    );
    return result.status === 'verified'
      ? { kind: 'attested', publicKey: null, signCount: result.signCount }
      : { kind: 'refused', reason: result.reason };
  }
  const decoded = await deps.decode(proof.token);
  if (decoded.status === 'invalid_token') return { kind: 'refused', reason: 'token_invalid' };
  if (decoded.status === 'unavailable') {
    console.error(
      JSON.stringify({ event: 'uts.attestation.play_unavailable', reason: decoded.reason })
    );
    return { kind: 'released' };
  }
  const checked = checkPlayVerdict(
    decoded.verdict,
    { ...deps.settings.play.expectation, requestHash: challenge },
    deps.now()
  );
  return checked.status === 'verified'
    ? { kind: 'attested', publicKey: null, signCount: null }
    : { kind: 'refused', reason: checked.reason };
}

async function runGate(
  proof: Proof | null,
  code: AttestedCode,
  deps: AttestationGateDeps
): Promise<GateOutcome> {
  const claimId = crypto.randomUUID();
  const claim = await deps.store(store =>
    store.claim({
      codeHash: code.codeHash,
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      codeChallenge: code.codeChallenge,
      dpopJkt: code.dpopJkt,
      claimId,
      proof:
        proof === null
          ? null
          : { type: proof.type, keyId: proof.type === 'play_integrity' ? null : proof.keyId },
    })
  );
  switch (claim.outcome) {
    case 'attested':
    case 'reused':
      return { status: 'exchange' };
    case 'proof_required':
    case 'unknown_key':
      return oauthError('attestation_required', 400, ATTESTATION_REQUIRED);
    case 'busy':
      return temporarilyUnavailable();
    case 'refused':
      return oauthError('invalid_grant', 400, 'the device attestation was refused');
    case 'invalid_grant':
      return oauthError('invalid_grant', 400, 'the grant is invalid, expired or revoked');
    case 'claimed':
      break;
  }
  // The claim statement answers `proof_required` for a request without an attestation.
  if (proof === null) throw new Error('an attestation was claimed without a proof');

  const settle = (result: SettleInput['result']) =>
    deps.store(store =>
      store.settle({ environment: deps.environment, codeHash: code.codeHash, claimId, result })
    );
  let result: SettleInput['result'];
  try {
    result = await verify(proof, claim.storedKey, code.code, deps);
  } catch (error) {
    // Let a retry verify again; the original error answers 500, whatever the release does.
    try {
      await settle({ kind: 'released' });
    } catch (releaseError) {
      console.error(
        JSON.stringify({
          event: 'uts.attestation.release_failed',
          error: releaseError instanceof Error ? releaseError.name : 'unknown',
        })
      );
    }
    throw error;
  }
  if (result.kind === 'refused') {
    console.error(
      JSON.stringify({ event: 'uts.attestation.refused', type: proof.type, reason: result.reason })
    );
  }
  switch (await settle(result)) {
    case 'attested':
      return { status: 'exchange' };
    case 'refused':
      return oauthError('invalid_grant', 400, 'the device attestation was refused');
    case 'key_known':
      // An attestation of a key UTS holds already: the app uses that key with assertions, or
      // attests a new one; this code stays usable.
      return oauthError('attestation_required', 400, ATTESTATION_REQUIRED);
    case 'released':
    case 'stale':
      return temporarilyUnavailable();
  }
}

/** The attestation step of one code exchange: `exchange` once the code is attested. */
export async function attestCodeExchange(
  params: Params,
  code: AttestedCode,
  deps: AttestationGateDeps
): Promise<GateOutcome> {
  const proof = readProof(params);
  if (proof instanceof Response) return proof;
  if (deps.inFlight.has(code.code)) return temporarilyUnavailable();
  deps.inFlight.add(code.code);
  try {
    return await runGate(proof, code, deps);
  } finally {
    deps.inFlight.delete(code.code);
  }
}
