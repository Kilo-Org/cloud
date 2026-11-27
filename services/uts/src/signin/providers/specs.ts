import type { UtsOAuthProvider } from '@kilocode/uts-contracts';
import { z } from 'zod';

/**
 * The protocol of each sign-in provider, checked against each provider's published OpenID
 * Connect discovery document or API reference (README, "Sign-in providers"). Endpoints are fixed
 * here, never discovered per request; only the development entry may point a provider at a local
 * stand-in (`SIGNIN_DEV_ENDPOINTS`, src/signin/providers/config.ts).
 *
 * How a provider proves control of an address (design 5.2, account linking):
 * * `google`: Google is authoritative for an address that ends in `@gmail.com`, or that is
 *   verified and has a hosted domain (`hd`), a Google Workspace account. Any other verified
 *   address was verified once and may since have changed hands, so it proves nothing
 *   (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
 * * `email_verified`: the ID token says `email_verified: true` (Apple sends the string `"true"`).
 * * `github_verified`: GitHub has no OpenID Connect; `/user/emails` marks the address verified.
 * * `discord_verified`: Discord's user object says `verified: true`.
 */

export type OidcEndpoints = {
  /** Every `iss` the provider's ID tokens carry. */
  issuers: readonly string[];
  authorization: string;
  token: string;
  jwks: string;
};

/** GitHub: OAuth 2 with the REST API for the user and their addresses. */
export type GitHubEndpoints = { authorization: string; token: string; api: string };

/** Discord: OAuth 2 with the user object. */
export type DiscordEndpoints = { authorization: string; token: string; user: string };

/** How the provider authenticates the client at its token endpoint. */
export type ClientAuthMethod =
  | 'client_secret_basic'
  | 'client_secret_post'
  /** Sign in with Apple: the client secret is an ES256 JWT that UTS signs per request. */
  | 'apple_client_secret'
  /** Claude: a JSON body with a `private_key_jwt` client assertion (RFC 7523); no secret exists. */
  | 'private_key_jwt_json';

export type OidcSpec = {
  protocol: 'oidc';
  endpoints: OidcEndpoints;
  scope: string;
  /** PKCE S256; false where the provider does not offer it to a web client. */
  pkce: boolean;
  /** Apple posts the callback when the request asks for a name or an address. */
  responseMode: 'query' | 'form_post';
  clientAuth: ClientAuthMethod;
  idTokenAlgorithms: readonly ('RS256' | 'ES256')[];
  /**
   * The ID token's `nonce`. UTS sends the flow's nonce to every provider. `required`: a token
   * without it is refused. `if_present`: a token without it passes (the provider never echoes it;
   * the state and the flow's binder cookie still tie the callback to the browser), and a token
   * with another nonce is refused.
   */
  idTokenNonce: 'required' | 'if_present';
  emailProof: 'google' | 'email_verified';
  /** Sent on the authorization request and the code exchange (OpenAI's API resource). */
  resource: string | null;
};

export type GitHubSpec = { protocol: 'github'; endpoints: GitHubEndpoints; scope: string };
export type DiscordSpec = { protocol: 'discord'; endpoints: DiscordEndpoints; scope: string };

export type ProviderSpec = OidcSpec | GitHubSpec | DiscordSpec;

/** WorkOS SSO (https://workos.com/docs/reference/sso): the API key authenticates the client. */
export type WorkosEndpoints = { authorization: string; token: string };

export const WORKOS_ENDPOINTS: WorkosEndpoints = {
  authorization: 'https://api.workos.com/sso/authorize',
  token: 'https://api.workos.com/sso/token',
};

const oidc = (
  spec: Omit<OidcSpec, 'protocol' | 'resource' | 'responseMode'> &
    Partial<Pick<OidcSpec, 'resource' | 'responseMode'>>
): OidcSpec => ({ protocol: 'oidc', resource: null, responseMode: 'query', ...spec });

export const PROVIDER_SPECS: Readonly<Record<UtsOAuthProvider, ProviderSpec>> = {
  google: oidc({
    endpoints: {
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    },
    scope: 'openid email profile',
    pkce: true,
    clientAuth: 'client_secret_post',
    idTokenAlgorithms: ['RS256'],
    idTokenNonce: 'required',
    emailProof: 'google',
  }),
  openai: oidc({
    endpoints: {
      issuers: ['https://auth.openai.com'],
      authorization: 'https://auth.openai.com/api/accounts/authorize',
      token: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks: 'https://auth.openai.com/.well-known/jwks.json',
    },
    scope: 'openid profile email',
    pkce: true,
    clientAuth: 'client_secret_basic',
    idTokenAlgorithms: ['RS256'],
    idTokenNonce: 'required',
    emailProof: 'email_verified',
    // The app's registration grants its tokens for this resource; the code exchange must repeat it.
    resource: 'https://api.openai.com/v1',
  }),
  anthropic: oidc({
    endpoints: {
      issuers: ['https://identity.anthropic.com/users'],
      authorization: 'https://auth.claude.com/oauth/authorize',
      token: 'https://auth.claude.com/v1/oauth/token',
      jwks: 'https://identity.anthropic.com/users/jwks.json',
    },
    scope: 'openid email profile',
    pkce: true,
    clientAuth: 'private_key_jwt_json',
    idTokenAlgorithms: ['ES256'],
    idTokenNonce: 'required',
    emailProof: 'email_verified',
  }),
  anaconda: oidc({
    endpoints: {
      issuers: ['https://auth.anaconda.com/api/auth'],
      authorization: 'https://anaconda.com/api/auth/oauth2/authorize',
      token: 'https://anaconda.com/api/auth/oauth2/token',
      jwks: 'https://anaconda.com/api/auth/.well-known/jwks.json',
    },
    scope: 'openid profile email',
    pkce: true,
    clientAuth: 'client_secret_post',
    idTokenAlgorithms: ['RS256'],
    idTokenNonce: 'required',
    emailProof: 'email_verified',
  }),
  apple: oidc({
    endpoints: {
      issuers: ['https://appleid.apple.com'],
      authorization: 'https://appleid.apple.com/auth/authorize',
      token: 'https://appleid.apple.com/auth/token',
      jwks: 'https://appleid.apple.com/auth/keys',
    },
    // The ID token carries the address only when `email` is requested, and Apple then requires
    // `form_post`. Apple's discovery document lists no PKCE method.
    scope: 'email',
    pkce: false,
    responseMode: 'form_post',
    clientAuth: 'apple_client_secret',
    idTokenAlgorithms: ['RS256'],
    idTokenNonce: 'required',
    emailProof: 'email_verified',
  }),
  github: {
    protocol: 'github',
    endpoints: {
      authorization: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      api: 'https://api.github.com',
    },
    scope: 'read:user user:email',
  },
  gitlab: oidc({
    endpoints: {
      issuers: ['https://gitlab.com'],
      authorization: 'https://gitlab.com/oauth/authorize',
      token: 'https://gitlab.com/oauth/token',
      jwks: 'https://gitlab.com/oauth/discovery/keys',
    },
    scope: 'openid email',
    pkce: true,
    clientAuth: 'client_secret_post',
    idTokenAlgorithms: ['RS256'],
    idTokenNonce: 'required',
    emailProof: 'email_verified',
  }),
  discord: {
    protocol: 'discord',
    endpoints: {
      authorization: 'https://discord.com/oauth2/authorize',
      token: 'https://discord.com/api/oauth2/token',
      user: 'https://discord.com/api/users/@me',
    },
    scope: 'identify email',
  },
  linkedin: oidc({
    endpoints: {
      issuers: ['https://www.linkedin.com/oauth'],
      authorization: 'https://www.linkedin.com/oauth/v2/authorization',
      token: 'https://www.linkedin.com/oauth/v2/accessToken',
      jwks: 'https://www.linkedin.com/oauth/openid/jwks',
    },
    scope: 'openid profile email',
    // LinkedIn's discovery document lists no PKCE method for web clients.
    pkce: false,
    clientAuth: 'client_secret_post',
    idTokenAlgorithms: ['RS256'],
    // LinkedIn's ID token carries no `nonce` (its documented claims are iss, sub, aud, iat, exp).
    idTokenNonce: 'if_present',
    emailProof: 'email_verified',
  }),
};

/** GitHub and Discord also use PKCE S256 (both document it for the authorization code grant). */
export function usesPkce(spec: ProviderSpec): boolean {
  return spec.protocol === 'oidc' ? spec.pkce : true;
}

const LocalUrlSchema = z
  .url()
  .refine(value => ['localhost', '127.0.0.1'].includes(new URL(value).hostname), 'a local URL');

/**
 * The endpoint overrides the development entry accepts, one shape per protocol, every URL on the
 * local host.
 */
export const DevEndpointsSchema = z.strictObject({
  oidc: z
    .record(
      z.string(),
      z.strictObject({
        issuers: z.array(LocalUrlSchema).min(1),
        authorization: LocalUrlSchema,
        token: LocalUrlSchema,
        jwks: LocalUrlSchema,
      })
    )
    .optional(),
  github: z
    .strictObject({ authorization: LocalUrlSchema, token: LocalUrlSchema, api: LocalUrlSchema })
    .optional(),
  discord: z
    .strictObject({ authorization: LocalUrlSchema, token: LocalUrlSchema, user: LocalUrlSchema })
    .optional(),
  workos: z.strictObject({ authorization: LocalUrlSchema, token: LocalUrlSchema }).optional(),
  /** Mailgun's API origin (the messages path is appended) and Turnstile's siteverify URL. */
  mail: z
    .strictObject({
      mailgun: LocalUrlSchema.refine(value => new URL(value).origin === value, 'an origin'),
      turnstile: LocalUrlSchema,
    })
    .optional(),
});
export type DevEndpoints = z.infer<typeof DevEndpointsSchema>;

/** The spec with the development entry's endpoints, where it gives any. */
export function specWithEndpoints(
  provider: UtsOAuthProvider,
  dev: DevEndpoints | null
): ProviderSpec {
  const spec = PROVIDER_SPECS[provider];
  if (dev === null) return spec;
  if (spec.protocol === 'oidc') {
    const endpoints = dev.oidc?.[provider];
    return endpoints === undefined ? spec : { ...spec, endpoints };
  }
  if (spec.protocol === 'github') {
    return dev.github === undefined ? spec : { ...spec, endpoints: dev.github };
  }
  return dev.discord === undefined ? spec : { ...spec, endpoints: dev.discord };
}
