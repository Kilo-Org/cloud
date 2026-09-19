import { z } from 'zod';

import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { postAuth } from '@/lib/auth/auth-fetch';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import { resolveAdmission } from '@/lib/auth/resolve-admission';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';

/** The one route that mints options and verifies the assertion, both server-side. */
const AUTHENTICATE_ROUTE = '/api/auth/passkey/authenticate';
/** The one route that mints registration options and verifies the attestation. */
const REGISTER_ROUTE = '/api/auth/passkey/register';

/**
 * The ceremony options the server minted. `@simplewebauthn/server` produces them
 * and they are the platform API's contract, so this client hands them over as
 * the JSON the server sent rather than re-declaring the WebAuthn shape.
 */
type CeremonyOptions = Record<string, unknown>;

/** A platform credential response, sent back to the server for verification. */
export type CredentialResponse = Record<string, unknown>;

/**
 * The slice of the platform credential API this module drives: the same calls on
 * iOS and Android, against the server routes that store the challenge. It is a
 * named contract so the ceremony can be exercised without a device.
 */
export type PasskeysApi = {
  isSupported: () => boolean;
  get: (request: CeremonyOptions) => Promise<CredentialResponse | null>;
  create: (request: CeremonyOptions) => Promise<CredentialResponse | null>;
};

/** Each file gets one attempt: a module that failed to load stays failed. */
type PasskeysCache = { api: PasskeysApi | null | undefined };

/** The loaded module, or `null` once a load has failed; `undefined` means "not tried yet". */
const passkeysModule: PasskeysCache = { api: undefined };

/**
 * Import the native module at most once. `react-native-passkeys` calls
 * `requireNativeModule('ReactNativePasskeys')` while it is being evaluated, so a
 * dev client built before that native module existed throws here. Keeping the
 * require inside the guard turns that into `passkeysSupported() === false`: the
 * login screen renders no passkey control and registration reports the
 * unsupported failure instead of crashing.
 */
function loadNativePasskeys(): PasskeysApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, unicorn/prefer-module -- the native module must only load lazily, behind the guard
    return require('react-native-passkeys') as PasskeysApi;
  } catch {
    return null;
  }
}

function loadPasskeys(): PasskeysApi | null {
  if (passkeysModule.api !== undefined) {
    return passkeysModule.api;
  }
  const loaded = loadNativePasskeys();
  passkeysModule.api = loaded;
  return loaded;
}

function usable(api: PasskeysApi | null): api is PasskeysApi {
  if (!api) {
    return false;
  }
  try {
    return api.isSupported();
  } catch {
    return false;
  }
}

/** False on a build without the native module or on a platform that cannot hold passkeys. */
export function passkeysSupported(): boolean {
  return usable(loadPasskeys());
}

/**
 * Why a passkey ceremony did not produce a session.
 *
 * - `cancelled`: the sheet was dismissed, the platform refused to show it, or a
 *   request never reached the server. The same button is a working retry.
 * - `expired`: the server refused the challenge itself — it expired, was already
 *   used, or did not match the one it stored — or the verify response was not
 *   one this client recognizes. A fresh ceremony mints a new challenge, so the
 *   same button is a working retry, exactly as in the web flow.
 * - `no-passkey`: the device holds no passkey this relying party accepts.
 *   Retrying cannot help; the other sign-in methods are the way out.
 * - `unsupported`: this build or platform cannot run the ceremony at all.
 * - `failed`: the ceremony ran, the server knew the passkey, and the assertion
 *   did not verify against it. The passkey is not usable as presented, so the
 *   other methods are the way out.
 */
export type PasskeyFailure = 'cancelled' | 'expired' | 'no-passkey' | 'unsupported' | 'failed';

const FAILURE_KEYS = {
  cancelled: 'login.passkeyCancelled',
  // Reused from the login screen: an expired challenge is a sign-in that could
  // not be completed, and the same generic retryable copy tells the user so.
  expired: 'login.couldNotCompleteSignIn',
  'no-passkey': 'login.passkeyNotFound',
  unsupported: 'login.passkeyUnsupported',
  failed: 'login.passkeyFailed',
} satisfies Record<PasskeyFailure, string>;

/** The catalog key that tells the user what happened, in the active language. */
export function passkeyFailureKey(failure: PasskeyFailure): string {
  return FAILURE_KEYS[failure];
}

const errorFieldsSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

/**
 * Classify a thrown credential-API error, case-insensitively. Android rejects
 * with the reason as the message ("UserCancelled", "NoCredentials",
 * "NotSupported", "NotConfigured", "Interrupted", "UnknownError",
 * "DomError: <type>"); iOS raises an exception whose name carries the same
 * reason ("UserCancelledException", "NotConfiguredException", …). Both are read
 * as one haystack, so a change on either side still lands on a known failure.
 */
export function classifyPasskeyError(error: unknown): PasskeyFailure {
  const fields = errorFieldsSchema.safeParse(error);
  const text = fields.success
    ? [fields.data.name, fields.data.message, fields.data.code].join(' ')
    : '';
  if (/cancel/i.test(text)) {
    return 'cancelled';
  }
  if (/nocredential|notallowed/i.test(text)) {
    return 'no-passkey';
  }
  if (/notsupported|notconfigured/i.test(text)) {
    return 'unsupported';
  }
  return 'failed';
}

/**
 * A ceremony's server-stored challenge and the options the platform API signs.
 * The options are handed to the platform verbatim — they are produced by
 * `simplewebauthn` on the server and their full shape is the platform's
 * contract, not this client's to re-declare.
 */
const ceremonyOptionsSchema = z.object({
  challengeId: z.string().min(1),
  options: z.unknown(),
});

const ticketSchema = z.object({ ticket: z.string().min(1) });

export type PasskeySignInResult =
  | {
      status: 'ok';
      token: string;
      refreshToken?: string;
      expiresIn?: number;
      created?: boolean;
    }
  | {
      status: 'error';
      failure: PasskeyFailure;
      /** A server code the caller maps to its own copy, when the server sent one. */
      errorCode?: string;
      /** The organization a forced-SSO refusal names, for the SSO recovery block. */
      ssoOrganizationId?: string;
      /** The failure already showed its own message; the caller must not toast again. */
      reported?: boolean;
    };

/**
 * Run one usernameless passkey sign-in: mint options server-side, let the
 * platform credential API produce the assertion, hand the assertion back for
 * server-side verification, then redeem the one-time ticket through the same
 * native token route the other providers use. The screen signs the returned
 * token pair in.
 */
export async function signInWithPasskey(
  api: PasskeysApi | null = loadPasskeys()
): Promise<PasskeySignInResult> {
  if (!usable(api)) {
    return { status: 'error', failure: 'unsupported' };
  }

  const optionsResult = await postAuth(AUTHENTICATE_ROUTE, { action: 'options' });
  if (!optionsResult.ok) {
    // Minting options opens no sheet, so nothing about the credential was
    // refused: the same button is a working retry.
    return { status: 'error', failure: 'cancelled' };
  }
  const ceremony = ceremonyOptionsSchema.safeParse(optionsResult.data);
  if (!ceremony.success) {
    return { status: 'error', failure: 'failed' };
  }

  let assertion: CredentialResponse | null = null;
  try {
    assertion = await api.get(ceremony.data.options as CeremonyOptions);
  } catch (error) {
    return { status: 'error', failure: classifyPasskeyError(error) };
  }
  if (!assertion) {
    // The platform API reports "no credential produced" as an empty result.
    return { status: 'error', failure: 'cancelled' };
  }

  const verifyResult = await postAuth(AUTHENTICATE_ROUTE, {
    action: 'verify',
    challengeId: ceremony.data.challengeId,
    response: assertion,
  });
  if (!verifyResult.ok) {
    // The server names a credential it has no passkey for; that is the one
    // refusal retrying the same device cannot fix.
    if (verifyResult.errorCode === 'UNKNOWN_CREDENTIAL') {
      return { status: 'error', failure: 'no-passkey' };
    }
    // A request that never reached the server refused nothing about the
    // credential, so it stays retryable.
    if (!verifyResult.errorCode) {
      return { status: 'error', failure: 'cancelled' };
    }
    // A known passkey whose signature did not verify cannot be retried into a
    // success on the same device.
    if (verifyResult.errorCode === 'VERIFICATION_FAILED') {
      return { status: 'error', failure: 'failed' };
    }
    // Everything else — an expired, replayed or mismatched challenge, and any
    // refusal this client does not recognize — is resolved by a fresh ceremony,
    // so the same button stays a working retry.
    return { status: 'error', failure: 'expired' };
  }
  const ticket = ticketSchema.safeParse(verifyResult.data);
  if (!ticket.success) {
    return { status: 'error', failure: 'failed' };
  }

  let admissionBody: Record<string, unknown> = {};
  try {
    admissionBody = await resolveAdmission();
  } catch {
    // resolveAdmission has already shown the retryable admission message.
    return { status: 'error', failure: 'cancelled', reported: true };
  }

  const tokenResult = await postAuth('/api/auth/native/token', {
    provider: 'passkey',
    ticket: ticket.data.ticket,
    supportsRefresh: true,
    ...admissionBody,
  });
  if (!tokenResult.ok) {
    if (!tokenResult.errorCode) {
      return { status: 'error', failure: 'cancelled' };
    }
    return {
      status: 'error',
      failure: 'failed',
      errorCode: tokenResult.errorCode,
      ssoOrganizationId: tokenResult.ssoOrganizationId,
    };
  }

  const parsed = parseTokenPair(tokenResult.data);
  if (!parsed) {
    return { status: 'error', failure: 'failed' };
  }
  return {
    status: 'ok',
    token: parsed.token,
    refreshToken: 'refreshToken' in parsed ? parsed.refreshToken : undefined,
    expiresIn: 'expiresIn' in parsed ? parsed.expiresIn : undefined,
    created: parsed.created,
  };
}

export type PasskeyRegistrationResult =
  | { status: 'ok' }
  | { status: 'error'; failure: 'cancelled' | 'unsupported' | 'failed' };

/** Creation has no credential to be missing yet, so `no-passkey` is just a refusal. */
function registrationFailure(error: unknown): 'cancelled' | 'unsupported' | 'failed' {
  const failure = classifyPasskeyError(error);
  return failure === 'cancelled' || failure === 'unsupported' ? failure : 'failed';
}

/**
 * Create a passkey for the signed-in user: mint registration options with the
 * session's bearer token, run the platform ceremony, then let the server verify
 * the attestation against the challenge it stored. The credential only exists
 * once the server has accepted it.
 */
export async function registerPasskey(
  api: PasskeysApi | null = loadPasskeys()
): Promise<PasskeyRegistrationResult> {
  if (!usable(api)) {
    return { status: 'error', failure: 'unsupported' };
  }

  const authHeaders = buildAuthHeaders(await getAuthTokenForRequest());
  const optionsResult = await postAuth(REGISTER_ROUTE, { action: 'options' }, authHeaders);
  if (!optionsResult.ok) {
    return { status: 'error', failure: 'failed' };
  }
  const ceremony = ceremonyOptionsSchema.safeParse(optionsResult.data);
  if (!ceremony.success) {
    return { status: 'error', failure: 'failed' };
  }

  let attestation: CredentialResponse | null = null;
  try {
    attestation = await api.create(ceremony.data.options as CeremonyOptions);
  } catch (error) {
    return { status: 'error', failure: registrationFailure(error) };
  }
  if (!attestation) {
    return { status: 'error', failure: 'cancelled' };
  }

  const verifyResult = await postAuth(
    REGISTER_ROUTE,
    {
      action: 'verify',
      challengeId: ceremony.data.challengeId,
      response: attestation,
    },
    authHeaders
  );
  if (!verifyResult.ok) {
    return { status: 'error', failure: 'failed' };
  }
  return { status: 'ok' };
}
