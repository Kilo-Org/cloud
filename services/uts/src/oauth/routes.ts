import {
  UTS_APPS_PAGE_PATH,
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
import { type AttestationService, attestationService } from '../attest/gate';
import { attestationAccess } from '../attest/store';
import { legacyBridgeKeys, webClientKeys } from '../bff/client-auth';
import { type WebClientDeps, noSsoAuthority } from '../bff/deps';
import type { HandleWindows } from '../bff/limits';
import { handleBrowserSessionRequest } from '../bff/routes';
import { webSessionAccess } from '../bff/store';
import { handleWebClientToken } from '../bff/token';
import type { Env, UtsConfig } from '../env';
import type { ExchangeService } from '../exchange/endpoint';
import { isolateSignerKeys, newKeyCopyState, shardSignerKeys } from '../exchange/keys';
import { newExchangeWindows } from '../exchange/limits';
import { grantsAccess, identityStoreBinding } from '../grants/binding';
import type { GrantsAccess } from '../grants/store';
import type { MintOptions } from '../http';
import { type FeedPublish, feedPublisher } from '../revocation/publish';
import type { ScopeRegistry } from '../scopes/policy';
import type { SignInDeps } from '../signin/deps';
import { type DeviceDeps, handleDeviceAuthorization } from '../signin/device/authorization';
import { deviceCodeGrant } from '../signin/device/grant';
import { userCodeSecret } from '../signin/device/user-code';
import { handleDeviceDecision, handleDevicePage } from '../signin/device/verification';
import { emailSignIn, platformFetch } from '../signin/email/delivery';
import { handleEmailRequest } from '../signin/email/routes';
import { signInChoices } from '../signin/flows';
import { requestSession, signInHandoff } from '../signin/handoff';
import { anonymousWriteRetryAfter } from '../signin/limits';
import { messagePage, passkeysPage, signInPage, unavailablePage } from '../signin/pages';
import { handlePasskeyOptions, handlePasskeyVerify } from '../signin/passkey/ceremonies';
import { logMisconfigured, signInConfigFor } from '../signin/providers/config';
import { handleProviderRequest } from '../signin/providers/routes';
import { providerSignInAccess } from '../signin/providers/store';
import { signInScript } from '../signin/script';
import { handleSsoRequest } from '../signin/sso/routes';
import { signInAccess } from '../signin/store';
import { type TicketDeps, handleTicketIssue } from '../tickets/routes';
import { ticketAccess } from '../tickets/store';
import {
  type ThirdPartyClients,
  type ThirdPartyClientsDeps,
  thirdPartyClients,
} from '../third-party/clients';
import { consentStep, handleAppsPage } from '../third-party/consent';
import { type ThirdPartyAccess, thirdPartyAccess } from '../third-party/store';
import { type SignerAccess, signerAccess } from '../token/mint';
import { classifyFailure } from './errors';
import { type AuthorizationHandoff, handleAuthorize } from './authorize';
import { handleIntrospect } from './introspect';
import { handleRevoke } from './revoke';
import { type DeviceCodeGrant, handleToken } from './token-endpoint';

/**
 * The RFC 8628 device grant: its token-endpoint hook and its pages where the user-code secret is
 * set (`served`). Where the secret is unset (`off`) or malformed (`misconfigured`) the grant is not
 * served and every other route works as before.
 */
export type DeviceService =
  | { status: 'served'; grant: DeviceCodeGrant; pages: DeviceDeps }
  | { status: 'off' | 'misconfigured' };

type ServedDevice = Extract<DeviceService, { status: 'served' }>;

/**
 * What an OAuth or sign-in request needs; the runtime tests pass their own stores, `scopes` and
 * `publish`.
 */
export type OAuthDeps = {
  config: UtsConfig;
  grants: GrantsAccess;
  sign: SignerAccess;
  /** The scope registry the endpoints enforce: `UTS_SCOPE_REGISTRY` in every deployed Worker. */
  scopes: ScopeRegistry;
  /** Writes a committed statement's feed entries to the feed objects (src/revocation/publish.ts). */
  publish: FeedPublish;
  handoff: AuthorizationHandoff;
  device: DeviceService;
  signIn: SignInDeps;
  tickets: TicketDeps;
  /** The web BFF `kilo-web`: its token grants and the browser-session API (src/bff/). */
  web: WebClientDeps;
  /** Third-party clients by their Client ID Metadata Document (src/third-party/clients.ts). */
  clients: ThirdPartyClients;
  /** The consents of the apps page (src/third-party/consent.ts). */
  thirdParty: ThirdPartyAccess;
  /** The RFC 8693 broker exchange; null until an STS token verifier is wired. */
  exchange: ExchangeService | null;
  /** Device attestation of `kilo-mobile` (src/attest/gate.ts). */
  attestation: AttestationService;
};

/** The OAuth endpoints are served only where the identity store is bound. */
export type OAuthService = { kind: 'unprovisioned' } | { kind: 'ready'; deps: OAuthDeps };

/** The browser-session API's per-handle call windows, per isolate (src/bff/limits.ts). */
const handleWindows: HandleWindows = new Map();

/**
 * Turns the sign-in pages' hand-off into the one the authorization endpoint uses. The deployed
 * entry uses it as is; only the development entry wraps it (src/dev.ts).
 */
export type HandoffChoice = (signInPages: AuthorizationHandoff) => AuthorizationHandoff;

/**
 * Per isolate: the client ids whose metadata fetch failed in the last minute and the fetches in
 * flight (src/third-party/clients.ts), the signer keys the broker exchange verifies subject tokens
 * with (src/exchange/keys.ts) and its rate windows (src/exchange/limits.ts).
 */
const metadataFailures: ThirdPartyClientsDeps['failures'] = new Map();
const metadataFetches: ThirdPartyClientsDeps['inFlight'] = new Map();
const exchangeKeys = newKeyCopyState();
const exchangeWindows = newExchangeWindows();

/**
 * `options.signer` null uses the grant's signer object; only the development entry passes another
 * one, to show a signing failure in the local end-to-end run (src/dev.ts). `options.scopes` is the
 * scope registry (`utsScopeEntry`) in every deployed entry; the development entry adds its fixture
 * scopes. `options.recordingMailer` is the development entry's mail port; every other entry
 * passes null, so the email sign-in is offered only where the mail settings are on
 * (src/signin/email/delivery.ts). `options.stsCallers` verifies the broker exchange's STS tokens:
 * `@kilocode/verify` in the deployed entry; null only in a development run without a stand-in STS,
 * where the exchange is not offered.
 */
export function oauthService(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  options: MintOptions
): OAuthService {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return binding;
  const { scopes } = options;
  const settings = signInConfigFor(env, config);
  const signIn: SignInDeps = {
    config,
    signIn: signInAccess(binding.connectionString, ctx),
    methods: {
      config,
      settings,
      store: providerSignInAccess(binding.connectionString, ctx),
      email: emailSignIn(settings, config.endpoints.issuer, options.recordingMailer, platformFetch),
    },
  };
  const signer = options.signer ?? signerAccess(env, config);
  const secret = userCodeSecret(env);
  const thirdParty = thirdPartyAccess(binding.connectionString, ctx);
  const signInPages = signInHandoff(
    signIn,
    consentStep({ config, thirdParty, scopes }, signIn.methods)
  );
  const handoff = options.authorizationHandoff;
  const publish = feedPublisher(env, config, ctx);
  return {
    kind: 'ready',
    deps: {
      config,
      grants: grantsAccess(binding.connectionString, ctx),
      sign: signer,
      scopes,
      publish,
      handoff: handoff === null ? signInPages : handoff(signInPages),
      device:
        secret.status === 'on'
          ? {
              status: 'served',
              grant: deviceCodeGrant({ config, sign: signer, scopes }, signIn.signIn),
              pages: { ...signIn, userCodeSecret: secret.secret },
            }
          : { status: secret.status },
      signIn,
      tickets: { config, tickets: ticketAccess(binding.connectionString, ctx) },
      web: {
        config,
        keys: () => webClientKeys(env),
        sessions: webSessionAccess(binding.connectionString, ctx),
        sign: signer,
        scopes,
        publish,
        // The authority check stays closed until the identity store holds SSO authority data. The
        // bridge verifies only under its own key set, so it also needs `KILO_WEB_BRIDGE_JWKS`.
        bridge:
          env.LEGACY_BRIDGE_ENABLED === 'true'
            ? { status: 'on', authority: noSsoAuthority, keys: () => legacyBridgeKeys(env) }
            : { status: 'off' },
        windows: handleWindows,
        now: Date.now,
      },
      clients: thirdPartyClients({
        store: thirdParty,
        fetcher: options.metadataFetcher,
        now: Date.now,
        failures: metadataFailures,
        inFlight: metadataFetches,
        fetchRetryAfter: address => anonymousWriteRetryAfter(address, 'client_metadata_fetch'),
      }),
      thirdParty,
      exchange:
        options.stsCallers === null
          ? null
          : {
              callers: options.stsCallers,
              keys: isolateSignerKeys(shardSignerKeys(env, config), exchangeKeys, Date.now),
              windows: exchangeWindows,
              now: Date.now,
            },
      attestation: attestationService(
        env,
        config,
        attestationAccess(binding.connectionString, ctx)
      ),
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

/**
 * The device grant for a device page, or null (the page is not served). A malformed secret is
 * logged once per request that reaches a device page, by name only.
 */
function servedDevice(device: DeviceService): ServedDevice | null {
  if (device.status === 'misconfigured') logMisconfigured('device', ['DEVICE_USER_CODE_KEY']);
  return device.status === 'served' ? device : null;
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
      return await handleToken(request, {
        ...deps,
        deviceCodeGrant: deps.device.status === 'served' ? deps.device.grant : null,
        webClient: (tokenRequest, grantType, params) =>
          handleWebClientToken(tokenRequest, grantType, params, deps.web),
      });
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
    case UTS_APPS_PAGE_PATH:
      return await handleAppsPage(request, {
        config: deps.config,
        thirdParty: deps.thirdParty,
        scopes: deps.scopes,
        methods,
        publish: deps.publish,
      });
    case UTS_SIGNIN_SCRIPT_PATH:
      return signInScript();
    case UTS_TICKETS_PATH:
      return await handleTicketIssue(request, deps.tickets);
    case UTS_DEVICE_AUTHORIZATION_PATH: {
      const device = servedDevice(deps.device);
      return device === null ? null : await handleDeviceAuthorization(request, device.pages);
    }
    case UTS_DEVICE_VERIFICATION_PATH: {
      const device = servedDevice(deps.device);
      return device === null ? null : await handleDevicePage(request, device.pages);
    }
    case UTS_DEVICE_DECISION_PATH: {
      const device = servedDevice(deps.device);
      return device === null ? null : await handleDeviceDecision(request, device.pages);
    }
    default:
      return await handleBrowserSessionRequest(request, pathname, deps.web);
  }
}
