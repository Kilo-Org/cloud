import type * as WebAuthn from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type * as WebAuthnHelpers from '@simplewebauthn/server/helpers';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { failureResponse } from '../../oauth/errors';
import { jsonResponse } from '../../responses';
import { base64url, randomCredential, sha256 } from '../../token/credentials';
import { anonymousWriteRefusal } from '../limits';
import { requestNetwork } from '../network';
import { readSameOriginJson } from '../requests';
import { sessionCookie, sessionCookieValue } from '../session';
import type { PasskeyDescriptor, SignInStore, StoredPasskey } from '../store';
import type { SignInDeps } from '../deps';

/**
 * `@simplewebauthn/server` and its ASN.1 parsers load on an isolate's first ceremony, not at its
 * start, so the token, refresh and ticket paths of the same Worker never pay for them.
 */
let library: Promise<typeof WebAuthn> | null = null;
let helpers: Promise<typeof WebAuthnHelpers> | null = null;
const webauthn = () => (library ??= import('@simplewebauthn/server'));
const webauthnHelpers = () => (helpers ??= import('@simplewebauthn/server/helpers'));

/**
 * The WebAuthn ceremonies of the sign-in pages (design 5.14), through `@simplewebauthn/server`:
 * sign-in with a discoverable passkey, which starts a browser session; registration of a passkey
 * in a signed-in session, a tier A action; and a passkey step-up of a session, a tier B check.
 *
 * * `POST /signin/passkey/options` stores a challenge (one statement) and answers the options.
 * * `POST /signin/passkey/verify` reads the challenge and the passkey (one statement), verifies
 *   the response in the Worker, and records the result (one statement): the session, the
 *   registration or the step-up, which consumes the challenge. Both statements share one
 *   connection.
 *
 * Every ceremony requires user verification, as the web app's passkeys do today. The relying
 * party comes from configuration (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`), never from the request.
 */

/** The browser's timeout for a ceremony; the challenge lives 5 minutes. */
const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;
const RP_NAME = 'Kilo';
/** A passkey request body holds one authenticator response; a larger body is refused unread. */
const MAX_BODY_BYTES = 16 * 1024;

const Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(8192);
const TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'usb', 'smart-card', 'cable'] as const;

const AuthenticationResponseSchema = z.strictObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
  clientExtensionResults: z.looseObject({}),
  response: z.strictObject({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Base64Url.optional(),
  }),
});

const RegistrationResponseSchema = z.strictObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
  clientExtensionResults: z.looseObject({}),
  response: z.strictObject({
    clientDataJSON: Base64Url,
    attestationObject: Base64Url,
    authenticatorData: Base64Url.optional(),
    transports: z.array(z.enum(TRANSPORTS)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: Base64Url.optional(),
  }),
});

/** A passkey's name as the user's list shows it. */
const PasskeyNameSchema = z
  .string()
  .trim()
  .regex(/^[^\p{Cc}\p{Cf}]{1,100}$/u);

const OptionsRequestSchema = z.strictObject({
  ceremony: z.enum(['sign_in', 'registration', 'step_up']),
});

const VerifyRequestSchema = z.discriminatedUnion('ceremony', [
  z.strictObject({ ceremony: z.literal('sign_in'), response: AuthenticationResponseSchema }),
  z.strictObject({ ceremony: z.literal('step_up'), response: AuthenticationResponseSchema }),
  z.strictObject({
    ceremony: z.literal('registration'),
    response: RegistrationResponseSchema,
    name: PasskeyNameSchema,
  }),
]);

/** The reason strings of a refused ceremony; the response and the audit row carry only these. */
type Refusal =
  | 'no_session'
  | 'unknown_challenge'
  | 'unknown_passkey'
  | 'passkey_refused'
  | 'challenge_used'
  | 'gate_required'
  | 'already_registered'
  | 'limit_reached'
  | 'no_passkey'
  | 'account_inactive'
  | 'sso_required';

const REFUSAL_STATUS: Record<Refusal, number> = {
  no_session: 401,
  unknown_challenge: 400,
  unknown_passkey: 400,
  passkey_refused: 400,
  challenge_used: 400,
  gate_required: 403,
  already_registered: 409,
  limit_reached: 409,
  no_passkey: 409,
  account_inactive: 403,
  // The account's address is in a domain whose org requires SSO (design 5.2).
  sso_required: 403,
};

function refused(reason: Refusal): Response {
  return jsonResponse({ error: reason }, REFUSAL_STATUS[reason]);
}

function descriptorsJson(passkeys: readonly PasskeyDescriptor[]) {
  return passkeys.map(passkey => ({
    id: base64url(passkey.credentialId),
    transports: [...passkey.transports],
  }));
}

/** A fresh challenge: 32 random bytes, and the SHA-256 the identity store keeps. */
async function newChallenge(): Promise<{ value: Uint8Array<ArrayBuffer>; hash: Uint8Array }> {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return { value, hash: await sha256(base64url(value)) };
}

/** The SHA-256 of a response's challenge, or null when the client data holds no valid one. */
async function challengeHashOf(
  clientDataJSON: string
): Promise<{ challenge: string; hash: Uint8Array } | null> {
  let challenge: string;
  try {
    challenge = (await webauthnHelpers()).decodeClientDataJSON(clientDataJSON).challenge;
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  return { challenge, hash: await sha256(challenge) };
}

async function sessionHashOf(request: Request): Promise<Uint8Array | null> {
  const value = sessionCookieValue(request);
  return value === null ? null : await sha256(value);
}

export async function handlePasskeyOptions(request: Request, deps: SignInDeps): Promise<Response> {
  const body = await readSameOriginJson(request, OptionsRequestSchema, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  const { rpId } = deps.config.relyingParty;
  const { ceremony } = body;
  const sessionTokenHash = ceremony === 'sign_in' ? null : await sessionHashOf(request);
  if (ceremony !== 'sign_in' && sessionTokenHash === null) return refused('no_session');
  if (ceremony === 'sign_in') {
    const address = requestNetwork(request).clientIp;
    const limited = anonymousWriteRefusal(address, 'passkey_sign_in_challenge');
    if (limited !== null) return limited;
  }
  const challenge = await newChallenge();

  try {
    const created = await deps.signIn(async store =>
      store.createChallenge({
        ceremony,
        challengeHash: challenge.hash,
        rpId,
        sessionTokenHash,
        newUserHandle:
          ceremony === 'registration' ? crypto.getRandomValues(new Uint8Array(32)) : null,
      })
    );
    if (created.outcome !== 'created') return refused(created.outcome);
    if (ceremony === 'registration') {
      if (created.registration === null) throw new Error('a registration challenge without a user');
      const { generateRegistrationOptions } = await webauthn();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userName: created.registration.accountEmail,
        userID: new Uint8Array(created.registration.userHandle),
        challenge: challenge.value,
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: 'none',
        excludeCredentials: descriptorsJson(created.passkeys),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      return jsonResponse({ options }, 200);
    }
    const { generateAuthenticationOptions } = await webauthn();
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      challenge: challenge.value,
      timeout: CEREMONY_TIMEOUT_MS,
      userVerification: 'required',
      allowCredentials: ceremony === 'step_up' ? descriptorsJson(created.passkeys) : [],
    });
    return jsonResponse({ options }, 200);
  } catch (error) {
    return failureResponse(error, 'passkey_options');
  }
}

/**
 * Verifies an assertion against the stored passkey. A discoverable sign-in must name the user
 * handle the passkey was created under (WebAuthn section 7.2, step 6).
 */
async function verifyAssertion(
  response: z.output<typeof AuthenticationResponseSchema>,
  challenge: string,
  passkey: StoredPasskey,
  deps: SignInDeps,
  ceremony: 'sign_in' | 'step_up'
): Promise<{ newCount: bigint; backedUp: boolean } | null> {
  if (ceremony === 'sign_in') {
    const handle = response.response.userHandle;
    if (handle === undefined || handle !== base64url(passkey.userHandle)) return null;
  }
  const json: AuthenticationResponseJSON = { ...response, clientExtensionResults: {} };
  try {
    const { verifyAuthenticationResponse } = await webauthn();
    const verified = await verifyAuthenticationResponse({
      response: json,
      expectedChallenge: challenge,
      expectedOrigin: [...deps.config.relyingParty.origins],
      expectedRPID: deps.config.relyingParty.rpId,
      credential: {
        // The passkey was found by this id.
        id: response.rawId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.signCount),
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });
    if (!verified.verified) return null;
    return {
      newCount: BigInt(verified.authenticationInfo.newCounter),
      backedUp: verified.authenticationInfo.credentialBackedUp,
    };
  } catch {
    return null;
  }
}

type Verified = z.output<typeof VerifyRequestSchema>;

async function verifySignIn(
  request: Request,
  body: Extract<Verified, { ceremony: 'sign_in' | 'step_up' }>,
  deps: SignInDeps,
  store: SignInStore
): Promise<Response> {
  const challenge = await challengeHashOf(body.response.response.clientDataJSON);
  if (challenge === null) return refused('unknown_challenge');
  const sessionTokenHash = body.ceremony === 'step_up' ? await sessionHashOf(request) : null;
  if (body.ceremony === 'step_up' && sessionTokenHash === null) return refused('no_session');
  const read = await store.readAssertion({
    ceremony: body.ceremony,
    challengeHash: challenge.hash,
    credentialId: Buffer.from(body.response.rawId, 'base64url'),
    sessionTokenHash,
  });
  if (read.outcome !== 'ok') return refused(read.outcome);
  const result = await verifyAssertion(
    body.response,
    challenge.challenge,
    read,
    deps,
    body.ceremony
  );
  if (result === null) {
    await store.recordPasskeyFailure(
      deps.config.environment,
      read.passkeyId,
      body.ceremony,
      'assertion invalid'
    );
    return refused('passkey_refused');
  }
  const use = {
    challengeHash: challenge.hash,
    passkeyId: read.passkeyId,
    previousCount: read.signCount,
    newCount: result.newCount,
    backedUp: result.backedUp,
  };

  if (body.ceremony === 'step_up') {
    if (sessionTokenHash === null) return refused('no_session');
    const stepUp = await store.completeStepUp({
      ...use,
      environment: deps.config.environment,
      sessionTokenHash,
    });
    if (stepUp.outcome !== 'completed') {
      return refused(stepUp.outcome === 'counter_conflict' ? 'challenge_used' : stepUp.outcome);
    }
    return jsonResponse(
      { outcome: 'step_up_completed', expires_at: stepUp.expiresAt.toISOString() },
      200
    );
  }

  const sessionToken = randomCredential();
  const signedIn = await store.completeSignIn({
    ...use,
    environment: deps.config.environment,
    sessionTokenHash: await sha256(sessionToken),
    network: requestNetwork(request),
  });
  if (signedIn.outcome !== 'signed_in') {
    return refused(signedIn.outcome === 'counter_conflict' ? 'challenge_used' : signedIn.outcome);
  }
  return jsonResponse({ outcome: 'signed_in' }, 200, { 'Set-Cookie': sessionCookie(sessionToken) });
}

async function verifyRegistration(
  request: Request,
  body: Extract<Verified, { ceremony: 'registration' }>,
  deps: SignInDeps,
  store: SignInStore
): Promise<Response> {
  const sessionTokenHash = await sessionHashOf(request);
  if (sessionTokenHash === null) return refused('no_session');
  const challenge = await challengeHashOf(body.response.response.clientDataJSON);
  if (challenge === null) return refused('unknown_challenge');
  const json: RegistrationResponseJSON = { ...body.response, clientExtensionResults: {} };
  let info;
  try {
    const { verifyRegistrationResponse } = await webauthn();
    const verified = await verifyRegistrationResponse({
      response: json,
      // The registration statement accepts only a challenge this session was given.
      expectedChallenge: challenge.challenge,
      expectedOrigin: [...deps.config.relyingParty.origins],
      expectedRPID: deps.config.relyingParty.rpId,
      requireUserVerification: true,
    });
    if (!verified.verified) return refused('passkey_refused');
    info = verified.registrationInfo;
  } catch {
    return refused('passkey_refused');
  }
  const registered = await store.registerPasskey({
    environment: deps.config.environment,
    challengeHash: challenge.hash,
    sessionTokenHash,
    credentialId: Buffer.from(info.credential.id, 'base64url'),
    publicKey: info.credential.publicKey,
    signCount: BigInt(info.credential.counter),
    aaguid: z.uuid().safeParse(info.aaguid).data ?? null,
    transports: body.response.response.transports ?? [],
    backupEligible: info.credentialDeviceType === 'multiDevice',
    backedUp: info.credentialBackedUp,
    name: body.name,
  });
  if (registered.outcome !== 'registered') return refused(registered.outcome);
  return jsonResponse({ outcome: 'registered', passkey_id: registered.passkeyId }, 201);
}

export async function handlePasskeyVerify(request: Request, deps: SignInDeps): Promise<Response> {
  const body = await readSameOriginJson(request, VerifyRequestSchema, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  try {
    return await deps.signIn(async store =>
      body.ceremony === 'registration'
        ? await verifyRegistration(request, body, deps, store)
        : await verifySignIn(request, body, deps, store)
    );
  } catch (error) {
    return failureResponse(error, 'passkey_verify');
  }
}
