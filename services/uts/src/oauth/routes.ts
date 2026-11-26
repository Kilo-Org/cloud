import {
  UTS_AUTHORIZE_PATH,
  UTS_DEVICE_AUTHORIZATION_PATH,
  UTS_DEVICE_DECISION_PATH,
  UTS_DEVICE_VERIFICATION_PATH,
  UTS_INTROSPECT_PATH,
  UTS_PASSKEY_OPTIONS_PATH,
  UTS_PASSKEY_VERIFY_PATH,
  UTS_PASSKEYS_PAGE_PATH,
  UTS_REVOKE_PATH,
  UTS_SIGNED_IN_PATH,
  UTS_SIGNIN_SCRIPT_PATH,
  UTS_TOKEN_PATH,
  UTS_TICKETS_PATH,
} from '@kilocode/uts-contracts';
import type { Env, UtsConfig } from '../env';
import { grantsAccess, identityStoreBinding } from '../grants/binding';
import type { GrantsAccess } from '../grants/store';
import type { SignInDeps } from '../signin/deps';
import { type DeviceDeps, handleDeviceAuthorization } from '../signin/device/authorization';
import { deviceCodeGrant } from '../signin/device/grant';
import { userCodeSecret } from '../signin/device/user-code';
import { handleDeviceDecision, handleDevicePage } from '../signin/device/verification';
import type { SignInMailer } from '../signin/email/mailer';
import { handleEmailRequest } from '../signin/email/routes';
import { signInChoices } from '../signin/flows';
import { requestSession, signInHandoff } from '../signin/handoff';
import { messagePage, passkeysPage, signInPage, unavailablePage } from '../signin/pages';
import { handlePasskeyOptions, handlePasskeyVerify } from '../signin/passkey/ceremonies';
import { signInConfigFor } from '../signin/providers/config';
import { handleProviderRequest } from '../signin/providers/routes';
import { providerSignInAccess } from '../signin/providers/store';
import { signInScript } from '../signin/script';
import { handleSsoRequest } from '../signin/sso/routes';
import { signInAccess } from '../signin/store';
import { type TicketDeps, handleTicketIssue } from '../tickets/routes';
import { ticketAccess } from '../tickets/store';
import { type SignerAccess, signerAccess } from '../token/mint';
import { classifyFailure } from './errors';
import { type AuthorizationHandoff, handleAuthorize } from './authorize';
import { handleIntrospect } from './introspect';
import { handleRevoke } from './revoke';
import { type DeviceCodeGrant, handleToken } from './token-endpoint';

/**
 * The RFC 8628 device grant: its token-endpoint hook and its pages. Served only where the
 * user-code secret is set.
 */
export type DeviceService = { grant: DeviceCodeGrant; pages: DeviceDeps };

/** What an OAuth or sign-in request needs; the runtime tests pass their own stores. */
export type OAuthDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  sign: SignerAccess;
  handoff: AuthorizationHandoff;
  device: DeviceService | null;
  signIn: SignInDeps;
  tickets: TicketDeps;
};

/** The OAuth endpoints are served only where the identity store is bound. */
export type OAuthService = { kind: 'unprovisioned' } | { kind: 'ready'; deps: OAuthDeps };

/**
 * Turns the sign-in pages' hand-off into the one the authorization endpoint uses. The deployed
 * entry uses it as is; only the development entry wraps it (src/dev.ts).
 */
export type HandoffChoice = (signInPages: AuthorizationHandoff) => AuthorizationHandoff;

/**
 * `sign` null uses the grant's signer object; only the development entry passes another one, to
 * show a signing failure in the local end-to-end run (src/dev.ts). `mailer` is the email sign-in's
 * mail port; no deployed sender is wired yet, so the deployed entry passes null and email sign-in
 * is not offered there.
 */
export function oauthService(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  handoff: HandoffChoice | null,
  sign: SignerAccess | null,
  mailer: SignInMailer | null
): OAuthService {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return binding;
  const signIn: SignInDeps = {
    config,
    signIn: signInAccess(binding.connectionString, ctx),
    methods: {
      config,
      settings: signInConfigFor(env, config),
      store: providerSignInAccess(binding.connectionString, ctx),
      mailer,
    },
  };
  const signer = sign ?? signerAccess(env, config);
  const secret = userCodeSecret(env);
  const signInPages = signInHandoff(signIn);
  return {
    kind: 'ready',
    deps: {
      config,
      grants: grantsAccess(binding.connectionString, ctx),
      sign: signer,
      handoff: handoff === null ? signInPages : handoff(signInPages),
      device:
        secret === null
          ? null
          : {
              grant: deviceCodeGrant({ config, sign: signer }, signIn.signIn),
              pages: { ...signIn, userCodeSecret: secret },
            },
      signIn,
      tickets: { config, tickets: ticketAccess(binding.connectionString, ctx) },
    },
  };
}

/** GET /signin/passkeys: the add-a-passkey page for a signed-in user, else the sign-in page. */
async function handlePasskeysPage(request: Request, deps: SignInDeps): Promise<Response> {
  try {
    return (await requestSession(request, deps)) === null
      ? signInPage(signInChoices(deps.methods, UTS_PASSKEYS_PAGE_PATH))
      : passkeysPage(deps.config.relyingParty.rpId);
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'passkeys_page') === 'retryable');
  }
}

/** GET /signin/done: where a sign-in without another destination lands. */
async function handleSignedInPage(request: Request, deps: SignInDeps): Promise<Response> {
  try {
    return (await requestSession(request, deps)) === null
      ? signInPage(signInChoices(deps.methods, UTS_SIGNED_IN_PATH))
      : messagePage('Signed in', 'You are signed in to Kilo. You can close this page.', 200, null);
  } catch (error) {
    return unavailablePage(classifyFailure(error, 'signed_in_page') === 'retryable');
  }
}

/** The response for an endpoint, or null when `pathname` names none that is served. */
export async function handleOAuthRequest(
  request: Request,
  pathname: string,
  deps: OAuthDeps
): Promise<Response | null> {
  const methods = deps.signIn.methods;
  const signInMethod =
    (await handleProviderRequest(request, pathname, methods)) ??
    (await handleSsoRequest(request, pathname, methods)) ??
    (await handleEmailRequest(request, pathname, methods));
  if (signInMethod !== null) return signInMethod;
  switch (pathname) {
    case UTS_SIGNED_IN_PATH:
      return await handleSignedInPage(request, deps.signIn);
    case UTS_AUTHORIZE_PATH:
      return await handleAuthorize(request, deps);
    case UTS_TOKEN_PATH:
      return await handleToken(request, { ...deps, deviceCodeGrant: deps.device?.grant ?? null });
    case UTS_REVOKE_PATH:
      return await handleRevoke(request, deps);
    case UTS_INTROSPECT_PATH:
      return await handleIntrospect(request, deps);
    case UTS_PASSKEY_OPTIONS_PATH:
      return await handlePasskeyOptions(request, deps.signIn);
    case UTS_PASSKEY_VERIFY_PATH:
      return await handlePasskeyVerify(request, deps.signIn);
    case UTS_PASSKEYS_PAGE_PATH:
      return await handlePasskeysPage(request, deps.signIn);
    case UTS_SIGNIN_SCRIPT_PATH:
      return signInScript();
    case UTS_TICKETS_PATH:
      return await handleTicketIssue(request, deps.tickets);
    case UTS_DEVICE_AUTHORIZATION_PATH:
      return deps.device === null
        ? null
        : await handleDeviceAuthorization(request, deps.device.pages);
    case UTS_DEVICE_VERIFICATION_PATH:
      return deps.device === null ? null : await handleDevicePage(request, deps.device.pages);
    case UTS_DEVICE_DECISION_PATH:
      return deps.device === null ? null : await handleDeviceDecision(request, deps.device.pages);
    default:
      return null;
  }
}
