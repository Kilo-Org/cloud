import {
  UTS_AUTHORIZE_PATH,
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_OAUTH_PROVIDERS,
  UTS_PASSKEYS_PAGE_PATH,
  UTS_SIGNED_IN_PATH,
  type UtsOAuthProvider,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { UtsConfig } from '../env';
import { classifyFailure } from '../oauth/errors';
import { base64url, isRandomCredential, randomCredential, sha256 } from '../token/credentials';
import type { SignInMailer } from './email/mailer';
import { anonymousWriteRetryAfter } from './limits';
import { requestNetwork } from './network';
import { type SignInChoices, continuePage, messagePage, unavailablePage } from './pages';
import type { SignInConfig } from './providers/config';
import type { FlowValues, IdentityResult } from './providers/exchange';
import type { FlowIntent, FlowProvider, ProviderSignInAccess } from './providers/store';
import { sessionCookie, sessionCookieValue } from './session';

/**
 * The provider, SSO and email sign-in of one environment: its configuration, its statements and
 * its mail port (null where no sender is wired, so email sign-in is not offered).
 */
export type SignInMethods = {
  config: UtsConfig;
  settings: SignInConfig;
  store: ProviderSignInAccess;
  mailer: SignInMailer | null;
};

const PROVIDER_NAMES: Readonly<Record<UtsOAuthProvider, string>> = {
  google: 'Google',
  openai: 'ChatGPT',
  anthropic: 'Claude',
  anaconda: 'Anaconda',
  apple: 'Apple',
  github: 'GitHub',
  gitlab: 'GitLab',
  discord: 'Discord',
  linkedin: 'LinkedIn',
};

/** What the sign-in page offers: every configured method, returning to `returnTo`. */
export function signInChoices(methods: SignInMethods, returnTo: string): SignInChoices {
  const { settings, config } = methods;
  return {
    returnTo,
    rpId: config.relyingParty.rpId,
    providers: UTS_OAUTH_PROVIDERS.filter(
      provider => settings.providers[provider].status === 'on'
    ).map(provider => ({ provider, name: PROVIDER_NAMES[provider] })),
    email: settings.emailHashKey.status === 'on' && methods.mailer !== null,
    sso: settings.sso.status === 'on',
  };
}

/**
 * What every provider and SSO flow shares (design 5.1, 5.2): the `state`, the browser binder, the
 * PKCE verifier and nonce, where the user returns, and the answers to a finished flow.
 *
 * * `state` is 32 random bytes sent to the provider; the identity store keeps its SHA-256.
 * * The binder is 32 random bytes in a cookie of the starting browser, named after the state, so
 *   flows in two tabs do not overwrite each other. The identity store keeps its SHA-256, and the
 *   callback must present it: a callback carried to another browser (login CSRF) fails.
 * * The PKCE verifier and the OpenID Connect nonce are HMAC-SHA-256 values of the binder under
 *   fixed labels, so no flow secret is stored anywhere but in the browser that started the flow.
 * * The binder cookie is `SameSite=None`: Apple posts its callback from its own site, and a
 *   `Lax` cookie would not come with that post. The state and the binder together protect the
 *   callback, not the cookie's site rule.
 */

/** Where a sign-in may return: only the issuer's own sign-in destinations. */
const RETURN_PATHS = new Set([
  UTS_AUTHORIZE_PATH,
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_PASSKEYS_PAGE_PATH,
  UTS_SIGNED_IN_PATH,
]);
const MAX_RETURN_LENGTH = 4096;

/**
 * The path a sign-in returns to: a relative path to one of the issuer's sign-in destinations, or
 * the signed-in page. Anything else, such as another origin, becomes the signed-in page.
 */
export function returnPathOf(value: string | null): string {
  if (value === null || value.length > MAX_RETURN_LENGTH || !value.startsWith('/')) {
    return UTS_SIGNED_IN_PATH;
  }
  let url: URL;
  try {
    url = new URL(value, 'https://issuer.invalid');
  } catch {
    return UTS_SIGNED_IN_PATH;
  }
  if (url.origin !== 'https://issuer.invalid' || !RETURN_PATHS.has(url.pathname)) {
    return UTS_SIGNED_IN_PATH;
  }
  // The parsed form, so no backslash or dot segment survives.
  return `${url.pathname}${url.search}`;
}

export type NewFlow = {
  state: string;
  stateHash: Uint8Array;
  binder: string;
  binderHash: Uint8Array;
};

export async function newFlow(): Promise<NewFlow> {
  const state = randomCredential();
  const binder = randomCredential();
  return { state, stateHash: await sha256(state), binder, binderHash: await sha256(binder) };
}

async function hmac(key: string, label: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return base64url(
    new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(label)))
  );
}

/** The PKCE pair (RFC 7636, S256) and the nonce of a flow, from its binder. */
export async function flowSecrets(
  binder: string
): Promise<{ verifier: string; challenge: string; nonce: string }> {
  const verifier = await hmac(binder, 'kilo-uts-signin-pkce');
  return {
    verifier,
    challenge: base64url(await sha256(verifier)),
    nonce: await hmac(binder, 'kilo-uts-signin-nonce'),
  };
}

/** The flow cookie's name: 16 hexadecimal digits of the state's hash. */
export function flowCookieName(stateHash: Uint8Array): string {
  const hex = [...stateHash.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `__Host-uts_flow_${hex}`;
}

/** A flow cookie lives as long as the flow. */
const FLOW_MAX_AGE_SECONDS = 600;

export function flowCookie(name: string, binder: string): string {
  return `${name}=${binder}; Path=/; Max-Age=${FLOW_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=None`;
}

export function clearedFlowCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`;
}

/** The binder the request carries for this flow, or null. A repeated cookie is refused. */
export function flowBinder(request: Request, name: string): string | null {
  const values = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`))
    .map(part => part.slice(name.length + 1));
  if (values.length !== 1) return null;
  const [value] = values;
  return isRandomCredential(value) ? value : null;
}

/** Why a finished sign-in was refused; each has its page text. */
export type SignInRefusal =
  | 'invalid_state'
  | 'link_required'
  | 'email_required'
  | 'email_unverified'
  | 'sso_required'
  | 'sso_refused'
  | 'account_blocked'
  | 'no_session'
  | 'gate_required'
  | 'method_in_use'
  | 'no_sso_connection'
  | 'invalid_link'
  | 'code_locked'
  | 'codes_stopped'
  | 'network_limited'
  | 'check_failed'
  | 'recipient_not_allowed';

const REFUSALS: Record<SignInRefusal, { status: number; message: string }> = {
  invalid_state: {
    status: 400,
    message: 'This sign-in expired or was already used. Start the sign-in again.',
  },
  link_required: {
    status: 409,
    message:
      'An account with this email address already exists. Sign in with a method that account already uses, then add this one in your account settings.',
  },
  email_required: {
    status: 400,
    message: 'The provider did not share an email address. Use another sign-in method.',
  },
  email_unverified: {
    status: 403,
    message:
      'The provider did not confirm this email address. Sign in with your email address first, then add this method in your account settings.',
  },
  sso_required: {
    status: 403,
    message: 'Your organization requires single sign-on. Choose "Sign in with SSO".',
  },
  sso_refused: {
    status: 403,
    message: 'Single sign-on is not set up for this email address.',
  },
  account_blocked: { status: 403, message: 'This account cannot sign in.' },
  no_session: { status: 401, message: 'Sign in first, then add the sign-in method again.' },
  gate_required: {
    status: 403,
    message:
      'Adding a sign-in method needs a fresh confirmation. Confirm the change and try again.',
  },
  method_in_use: { status: 409, message: 'This sign-in method belongs to another account.' },
  no_sso_connection: {
    status: 404,
    message: 'Single sign-on is not set up for this email domain.',
  },
  invalid_link: {
    status: 400,
    message: 'This sign-in link expired or was already used. Request a new email.',
  },
  code_locked: {
    status: 403,
    message: 'Too many wrong codes. This code no longer works; use the link in the email.',
  },
  codes_stopped: {
    status: 429,
    message: 'Too many wrong codes for this address. Use the link in the email.',
  },
  network_limited: {
    status: 429,
    message:
      'Too many wrong codes from your network. Use the link in the email, or try again in an hour.',
  },
  check_failed: {
    status: 400,
    message: 'The check that you are a person did not pass. Go back and try again.',
  },
  recipient_not_allowed: {
    status: 403,
    message: 'This test environment sends sign-in email only to test addresses.',
  },
};

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The id of an account a sign-in creates: `uts_` and 26 lower-case base32 characters (RFC 4648
 * alphabet) of 128 random bits. No app user id has this form, so accounts imported from the app
 * keep their own ids without a collision.
 */
export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      text += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 128 bits leave 3; the last character carries them, padded with zeros.
  text += BASE32[(value << (5 - bits)) & 31];
  return `uts_${text}`;
}

/** The page of a refused sign-in, with a way back to where the sign-in started. */
export function refusalPage(refusal: SignInRefusal, returnTo: string | null): Response {
  const { status, message } = REFUSALS[refusal];
  return messagePage('Sign in to Kilo', message, status, returnTo);
}

/** Too many anonymous sign-in starts from one network: 429 with `Retry-After`, and a way back. */
export function rateLimitedPage(retryAfter: number, returnTo: string | null): Response {
  const response = messagePage(
    'Sign in to Kilo',
    'Too many sign-in attempts from your network. Wait a minute and try again.',
    429,
    returnTo
  );
  response.headers.set('Retry-After', String(retryAfter));
  return response;
}

/** A provider or mail service failed: 502 with `Retry-After` when a retry can succeed. */
export function upstreamFailurePage(retryable: boolean, returnTo: string | null): Response {
  const response = messagePage(
    'Sign in to Kilo',
    'The sign-in could not be completed. Try again in a moment.',
    retryable ? 503 : 502,
    returnTo
  );
  if (retryable) response.headers.set('Retry-After', '2');
  return response;
}

/** A finished sign-in: the session cookie, and back to where the sign-in started. */
export function signedInRedirect(
  sessionToken: string,
  returnTo: string,
  extraCookies: readonly string[] = []
): Response {
  const headers = new Headers({ Location: returnTo, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', sessionCookie(sessionToken));
  for (const cookie of extraCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** A redirect that sets or clears cookies, such as a flow's start or a finished link. */
export function redirectWithCookies(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Sign-in form posts are small; a larger body is refused unread. */
const MAX_FORM_BYTES = 8 * 1024;

/** The fields of a URL-encoded form post, or null for another content type or a large body. */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return null;
  }
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_FORM_BYTES) return null;
  const text = await request.text();
  return text.length > MAX_FORM_BYTES ? null : new URLSearchParams(text);
}

/**
 * The start of a provider or SSO flow, shared by both. `intent=link` with `gate_pass` (the id of a
 * tier A `method_add` pass of the request's browser session) adds the method to the signed-in
 * account instead of signing in (design 5.2, 5.11). The statement stores the flow; the answer sets
 * the binder cookie and redirects to the provider.
 */
export async function beginFlow(
  request: Request,
  methods: SignInMethods,
  provider: FlowProvider,
  params: {
    returnTo: string;
    intent: string | null;
    gatePass: string | null;
    ssoDomain: string | null;
    /**
     * `redirect` for a link's GET start; `page` for a form post's start, which answers with a page
     * that navigates on (`continuePage`), so no form-submission redirect chain reaches the provider.
     */
    answer: 'redirect' | 'page';
  },
  /** Null when the stored flow cannot reach the provider, a failure no retry fixes. */
  providerUrl: (values: FlowValues, workosConnectionId: string | null) => URL | null
): Promise<Response> {
  let intent: FlowIntent = { kind: 'sign_in' };
  if (params.intent === 'link') {
    const sessionValue = sessionCookieValue(request);
    const gatePass = z.uuid().safeParse(params.gatePass);
    if (sessionValue === null) return refusalPage('no_session', params.returnTo);
    if (!gatePass.success) return refusalPage('gate_required', params.returnTo);
    intent = {
      kind: 'link',
      sessionTokenHash: await sha256(sessionValue),
      gatePassId: gatePass.data,
    };
  } else if (params.intent !== null && params.intent !== 'sign_in') {
    return messagePage('Sign in to Kilo', 'Unknown sign-in request.', 400, params.returnTo);
  } else {
    // A sign-in start stores a flow row before anyone is signed in.
    const retryAfter = anonymousWriteRetryAfter(
      requestNetwork(request).clientIp,
      provider === 'workos' ? 'sso_sign_in_start' : 'provider_sign_in_start'
    );
    if (retryAfter !== null) return rateLimitedPage(retryAfter, params.returnTo);
  }
  const flow = await newFlow();
  let started;
  try {
    started = await methods.store(store =>
      store.startFlow({
        environment: methods.config.environment,
        stateHash: flow.stateHash,
        binderHash: flow.binderHash,
        provider,
        intent,
        ssoDomain: params.ssoDomain,
        returnTo: params.returnTo,
      })
    );
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'signin_start') === 'retryable');
  }
  if (started.outcome !== 'started') {
    logSignInOutcome('flow_start', provider, started.outcome);
    return refusalPage(started.outcome, params.returnTo);
  }
  const secrets = await flowSecrets(flow.binder);
  const url = providerUrl(
    { state: flow.state, challenge: secrets.challenge, nonce: secrets.nonce },
    started.workosConnectionId
  );
  if (url === null) {
    console.error(JSON.stringify({ event: 'uts.signin.start_failed', provider }));
    return messagePage('Sign in to Kilo', 'The sign-in could not be started.', 500, null);
  }
  const cookie = flowCookie(flowCookieName(flow.stateHash), flow.binder);
  if (params.answer === 'redirect') return redirectWithCookies(url.toString(), [cookie]);
  const response = continuePage("Continuing to your organization's sign-in.", url.toString());
  response.headers.append('Set-Cookie', cookie);
  return response;
}

/**
 * A callback that came back with `error` (the user cancelled, or the provider refused): the flow
 * expires unused, and the answer clears its binder cookie.
 */
export async function cancelledFlowPage(state: string | null, message: string): Promise<Response> {
  const response = messagePage('Sign in to Kilo', message, 400, null);
  if (state !== null && isRandomCredential(state)) {
    response.headers.append('Set-Cookie', clearedFlowCookie(flowCookieName(await sha256(state))));
  }
  return response;
}

/** A log line for a sign-in that ended without a session; ids and outcomes only. */
export function logSignInOutcome(method: string, provider: string | null, outcome: string): void {
  console.log(JSON.stringify({ event: 'uts.signin.outcome', method, provider, outcome }));
}

/**
 * The end of a provider or SSO callback, shared by both: checks that the request carries the flow's
 * binder, asks the provider for the identity, and runs the one statement that consumes the flow
 * and signs in or links. Every answer clears the flow cookie.
 */
export async function finishFlow(
  request: Request,
  methods: SignInMethods,
  provider: FlowProvider,
  state: string | null,
  identityOf: (secrets: { verifier: string; nonce: string }) => Promise<IdentityResult>
): Promise<Response> {
  if (state === null || !isRandomCredential(state)) return refusalPage('invalid_state', null);
  const stateHash = await sha256(state);
  const cookieName = flowCookieName(stateHash);
  const cleared = clearedFlowCookie(cookieName);
  const withCleared = (response: Response): Response => {
    response.headers.append('Set-Cookie', cleared);
    return response;
  };
  const binder = flowBinder(request, cookieName);
  if (binder === null) {
    logSignInOutcome('flow', provider, 'no_binder');
    return withCleared(refusalPage('invalid_state', null));
  }
  const secrets = await flowSecrets(binder);
  const identity = await identityOf(secrets);
  if (identity.status === 'failed') {
    console.error(
      JSON.stringify({
        event: 'uts.signin.provider_failed',
        provider,
        kind: identity.failure.kind,
        reason: identity.failure.reason,
      })
    );
    return withCleared(upstreamFailurePage(identity.failure.kind === 'retryable', null));
  }
  const sessionToken = randomCredential();
  let result;
  try {
    result = await methods.store(async store =>
      store.completeFlow({
        environment: methods.config.environment,
        stateHash,
        binderHash: await sha256(binder),
        provider,
        identity: identity.identity,
        sessionTokenHash: await sha256(sessionToken),
        newAccountId: newAccountId(),
        network: requestNetwork(request),
      })
    );
  } catch (error) {
    return withCleared(unavailablePage(classifyFailure(error, 'signin_callback') === 'retryable'));
  }
  switch (result.outcome) {
    case 'signed_in':
      return signedInRedirect(sessionToken, result.returnTo, [cleared]);
    case 'linked':
      return redirectWithCookies(result.returnTo, [cleared]);
    case 'invalid_state':
      logSignInOutcome('flow', provider, result.outcome);
      return withCleared(refusalPage('invalid_state', null));
    default:
      logSignInOutcome('flow', provider, result.outcome);
      return withCleared(refusalPage(result.outcome, result.returnTo));
  }
}
