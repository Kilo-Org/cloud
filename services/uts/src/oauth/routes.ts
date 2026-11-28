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
import type { CiExchangeService } from '../ci/exchange';
import { githubKeys, newGithubKeyState } from '../ci/github-keys';
import { ciPolicies } from '../ci/policy';
import { ciTokenAccess } from '../ci/store';
import type { Env, UtsConfig } from '../env';
import type { ExchangeService } from '../exchange/endpoint';
import { isolateSignerKeys, newKeyCopyState, shardSignerKeys } from '../exchange/keys';
import { newExchangeWindows } from '../exchange/limits';
import { grantsAccess, identityStoreBinding } from '../grants/binding';
import type { GrantsAccess } from '../grants/store';
import {
  type HomeWidgetService,
  handleHomeWidgetExchange,
  homeWidgetService,
} from '../home-widget/exchange';
import type { MintOptions } from '../http';
import { type FeedPublish, feedPublisher } from '../revocation/publish';
import type { UtsSecrets } from '../secrets';
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
import { classifyFailure, temporarilyUnavailable } from './errors';
import { type AuthorizationHandoff, handleAuthorize } from './authorize';
import { handleIntrospect } from './introspect';
import { handleRevoke } from './revoke';
import { type DeviceCodeGrant, handleToken } from './token-endpoint';

/**
 * The RFC 8628 device grant: its token-endpoint hook and its pages where the user-code secret is
 * set (`served`). Where the secret is unset (`off`) or malformed (`misconfigured`) the grant is not
 * served and every other route works as before; where STS gave no usable bundle (`unavailable`)
 * its routes answer a retryable 503.
 */
export type DeviceService =
  | { status: 'served'; grant: DeviceCodeGrant; pages: DeviceDeps }
  | { status: 'off' | 'misconfigured' | 'unavailable' };

type ServedDevice = Extract<DeviceService, { status: 'served' }>;

/**
 * What reads the runtime secrets (src/secrets.ts): the sign-in methods and the pages that list
 * them, the device grant and the attestation of `kilo-mobile`.
 */
export type SecretDeps = {
  handoff: AuthorizationHandoff;
  device: DeviceService;
  signIn: SignInDeps;
  /** Device attestation of `kilo-mobile` (src/attest/gate.ts). */
  attestation: AttestationService;
};

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
  tickets: TicketDeps;
  /** The web BFF `kilo-web`: its token grants and the browser-session API (src/bff/). */
  web: WebClientDeps;
  /** Third-party clients by their Client ID Metadata Document (src/third-party/clients.ts). */
  clients: ThirdPartyClients;
  /** The consents of the apps page (src/third-party/consent.ts). */
  thirdParty: ThirdPartyAccess;
  /** The RFC 8693 broker exchange; null until an STS token verifier is wired. */
  exchange: ExchangeService | null;
  /** The home-widget exchange's switch (src/home-widget/exchange.ts). */
  homeWidget: HomeWidgetService;
  /** The CI token exchange (src/ci/); off unless `CI_TOKEN_POLICIES` lists trust policies. */
  ci: CiExchangeService;
  /**
   * The secret-reading deps, built on first use in the request, so the refresh, revocation,
   * introspection, ticket and browser-session routes never wait for STS.
   */
  secretDeps: () => Promise<SecretDeps>;
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
/** Per isolate: GitHub's OIDC key set and the CI exchange's denied-row times (src/ci/). */
const githubKeyState = newGithubKeyState();
const ciDeniedAudits = new Map<string, number>();

/** The CI exchange of this environment's `CI_TOKEN_POLICIES`, over the isolate's state. */
function ciExchange(
  env: Env,
  config: UtsConfig,
  scopes: ScopeRegistry,
  connectionString: string,
  ctx: ExecutionContext
): CiExchangeService {
  const policies = ciPolicies(env, config.environment, scopes);
  if (policies.status !== 'on') return policies;
  return {
    status: 'on',
    policies: policies.policies,
    keys: githubKeys(githubKeyState, (input, init) => fetch(input, init), Date.now),
    store: ciTokenAccess(connectionString, ctx),
    deniedAudits: ciDeniedAudits,
    now: Date.now,
  };
}

/**
 * `options.signer` null uses the grant's signer object; only the development entry passes another
 * one, to show a signing failure in the local end-to-end run (src/dev.ts). `options.scopes` is the
 * scope registry (`utsScopeEntry`) in every deployed entry; the development entry adds its fixture
 * scopes. `options.recordingMailer` is the development entry's mail port; every other entry
 * passes null, so the email sign-in is offered only where the mail settings are on
 * (src/signin/email/delivery.ts). `options.stsCallers` verifies the broker exchange's STS tokens:
 * `@kilocode/verify` in the deployed entry; null only in a development run without a stand-in STS,
 * where the exchange is not offered. `secrets` is the request's one secrets read (`requestSecrets`).
 */
export function oauthService(
  env: Env,
  ctx: ExecutionContext,
  config: UtsConfig,
  options: MintOptions,
  secrets: () => Promise<UtsSecrets>
): OAuthService {
  const binding = identityStoreBinding(env);
  if (binding.kind === 'unprovisioned') return binding;
  const { scopes } = options;
  const signer = options.signer ?? signerAccess(env, config);
  const thirdParty = thirdPartyAccess(binding.connectionString, ctx);
  const signInStore = signInAccess(binding.connectionString, ctx);
  const methodStore = providerSignInAccess(binding.connectionString, ctx);
  const handoff = options.authorizationHandoff;
  const publish = feedPublisher(env, config, ctx);
  const buildSecretDeps = async (): Promise<SecretDeps> => {
    const read = await secrets();
    const settings = signInConfigFor(env, read, config);
    const signIn: SignInDeps = {
      config,
      signIn: signInStore,
      methods: {
        config,
        settings,
        store: methodStore,
        email: emailSignIn(
          settings,
          config.endpoints.issuer,
          options.recordingMailer,
          platformFetch
        ),
      },
    };
    const secret = userCodeSecret(read);
    const signInPages = signInHandoff(
      signIn,
      consentStep({ config, thirdParty, scopes }, signIn.methods)
    );
    return {
      signIn,
      handoff: handoff === null ? signInPages : handoff(signInPages),
      device:
        secret.status === 'on'
          ? {
              status: 'served',
              grant: deviceCodeGrant({ config, sign: signer, scopes }, signInStore),
              pages: { ...signIn, userCodeSecret: secret.secret },
            }
          : { status: secret.status },
      attestation: attestationService(
        env,
        read,
        config,
        attestationAccess(binding.connectionString, ctx)
      ),
    };
  };
  let secretDeps: Promise<SecretDeps> | null = null;
  return {
    kind: 'ready',
    deps: {
      config,
      grants: grantsAccess(binding.connectionString, ctx),
      sign: signer,
      scopes,
      publish,
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
      homeWidget: homeWidgetService(env),
      ci: ciExchange(env, config, scopes, binding.connectionString, ctx),
      secretDeps: () => {
        secretDeps ??= buildSecretDeps();
        return secretDeps;
      },
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
 * The device grant for a device page, `unavailable` (the route answers 503), or null (the page is
 * not served). A malformed secret is logged once per request that reaches a device page, by name
 * only.
 */
function servedDevice(device: DeviceService): ServedDevice | 'unavailable' | null {
  if (device.status === 'misconfigured') logMisconfigured('device', ['DEVICE_USER_CODE_KEY']);
  if (device.status === 'unavailable') return 'unavailable';
  return device.status === 'served' ? device : null;
}

/**
 * The sign-in pages, their JSON calls, the provider, SSO and email routes, the authorization
 * endpoint and the device pages: the routes that read the runtime secrets before they answer.
 */
function readsSecrets(pathname: string): boolean {
  return (
    pathname.startsWith('/signin/') ||
    pathname === UTS_AUTHORIZE_PATH ||
    pathname === UTS_DEVICE_AUTHORIZATION_PATH ||
    pathname === UTS_DEVICE_VERIFICATION_PATH ||
    pathname === UTS_DEVICE_DECISION_PATH
  );
}

/** The response for an endpoint, or null when `pathname` names none that is served. */
export async function handleOAuthRequest(
  request: Request,
  pathname: string,
  deps: OAuthDeps
): Promise<Response | null> {
  switch (pathname) {
    case UTS_TOKEN_PATH:
      return await handleToken(request, {
        ...deps,
        deviceCodeGrant: async () => (await deps.secretDeps()).device,
        attestation: async () => (await deps.secretDeps()).attestation,
        webClient: (tokenRequest, grantType, params) =>
          handleWebClientToken(tokenRequest, grantType, params, deps.web),
        homeWidgetGrant:
          deps.homeWidget.status === 'on'
            ? (tokenRequest, params) => handleHomeWidgetExchange(tokenRequest, params, deps)
            : null,
      });
    case UTS_REVOKE_PATH:
      return await handleRevoke(request, deps);
    case UTS_INTROSPECT_PATH:
      return await handleIntrospect(request, deps);
    case UTS_SIGNIN_SCRIPT_PATH:
      return signInScript();
    case UTS_TICKETS_PATH:
      return await handleTicketIssue(request, deps.tickets);
  }
  if (!readsSecrets(pathname)) {
    return await handleBrowserSessionRequest(request, pathname, deps.web);
  }
  const secret = await deps.secretDeps();
  const { signIn } = secret;
  const signInMethod =
    (await handleProviderRequest(request, pathname, signIn.methods)) ??
    (await handleSsoRequest(request, pathname, signIn.methods)) ??
    (await handleEmailRequest(request, pathname, signIn.methods));
  if (signInMethod !== null) return signInMethod;
  switch (pathname) {
    case UTS_SIGNED_IN_PATH:
      return await handleSignedInPage(request, signIn);
    case UTS_AUTHORIZE_PATH:
      return await handleAuthorize(request, { ...deps, ...secret });
    case UTS_PASSKEY_OPTIONS_PATH:
      return await handlePasskeyOptions(request, signIn);
    case UTS_PASSKEY_VERIFY_PATH:
      return await handlePasskeyVerify(request, signIn);
    case UTS_PASSKEYS_PAGE_PATH:
      return await handlePasskeysPage(request, signIn);
    case UTS_APPS_PAGE_PATH:
      return await handleAppsPage(request, {
        config: deps.config,
        thirdParty: deps.thirdParty,
        scopes: deps.scopes,
        methods: signIn.methods,
        publish: deps.publish,
      });
    case UTS_DEVICE_AUTHORIZATION_PATH: {
      const device = servedDevice(secret.device);
      if (device === 'unavailable') return temporarilyUnavailable();
      return device === null ? null : await handleDeviceAuthorization(request, device.pages);
    }
    case UTS_DEVICE_VERIFICATION_PATH: {
      const device = servedDevice(secret.device);
      if (device === 'unavailable') return unavailablePage(true);
      return device === null ? null : await handleDevicePage(request, device.pages);
    }
    case UTS_DEVICE_DECISION_PATH: {
      const device = servedDevice(secret.device);
      if (device === 'unavailable') return unavailablePage(true);
      return device === null ? null : await handleDeviceDecision(request, device.pages);
    }
    default:
      return null;
  }
}
