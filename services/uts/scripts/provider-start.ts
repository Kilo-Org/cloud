import {
  UTS_ENDPOINTS,
  UtsOAuthProviderSchema,
  utsProviderCallbackPath,
  type UtsOAuthProvider,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { PROVIDER_SPECS, usesPkce } from '../src/signin/providers/specs';

/**
 * The checks of `scripts/provider-signin-proof.ts`, on what a deployed issuer answers without
 * credentials: the providers its sign-in page offers, and the redirect each provider start sends.
 */

/** The issuers the proof runs against. */
export const PROOF_ISSUERS = [
  UTS_ENDPOINTS.staging.issuer,
  UTS_ENDPOINTS.production.issuer,
] as const;

const ClientIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, 'a client id');
const ExpectationSchema = z.tuple([UtsOAuthProviderSchema, ClientIdSchema]);

/**
 * `UTS_PROOF_PROVIDERS`: comma-separated `<provider>=<client id>` pairs, every provider the issuer
 * must offer and no other; empty for an issuer that offers none.
 */
export function parseExpectedProviders(value: string): ReadonlyMap<UtsOAuthProvider, string> {
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => ExpectationSchema.parse(entry.split('=')));
  const expected = new Map(entries);
  if (expected.size !== entries.length) {
    throw new Error('UTS_PROOF_PROVIDERS names a provider twice');
  }
  return expected;
}

const START_HREF = /href="\/signin\/oauth\/([^/"]+)\/start[?"]/g;

/** The providers whose start the sign-in page links to, each once, in page order. */
export function providersOnPage(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(START_HREF), ([, provider]) => provider))];
}

/** The page offers exactly the expected providers. */
export function pageProblems(
  listed: readonly string[],
  expected: ReadonlyMap<UtsOAuthProvider, string>
): string[] {
  const expectedNames = new Set<string>(expected.keys());
  const missing = [...expectedNames].filter(provider => !listed.includes(provider));
  const unexpected = listed.filter(provider => !expectedNames.has(provider));
  return [
    ...(missing.length > 0 ? [`does not offer ${missing.join(', ')}`] : []),
    ...(unexpected.length > 0 ? [`offers ${unexpected.join(', ')} beyond the expected`] : []),
  ];
}

/** What a provider start answered, read without following the redirect. */
export type StartAnswer = {
  status: number;
  location: string | null;
  setCookies: readonly string[];
};

/** An RFC 7636 S256 challenge: a SHA-256 digest in base64url without padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** The flow's binder cookie (`src/signin/flows.ts`), never readable by script or sent in clear. */
const BINDER_COOKIE = /^__Host-uts_flow_[0-9a-f]{16}=[^;]+;/;

/**
 * The start answers 303 to the provider's fixed authorization endpoint (`src/signin/providers/
 * specs.ts`) with the expected client id, the issuer's callback as `redirect_uri`, the provider's
 * scope, a `state`, PKCE S256 where the provider offers it and a `nonce` for OpenID Connect, and
 * sets the flow's binder cookie. Problems name values only for public parameters; a state,
 * challenge, nonce or cookie value is never part of one.
 */
export function startProblems(
  issuer: string,
  provider: UtsOAuthProvider,
  clientId: string,
  answer: StartAnswer
): string[] {
  if (answer.status !== 303) return [`answers ${answer.status}; expected 303`];
  const target = z.url().safeParse(answer.location);
  if (!target.success) return ['answers 303 without a valid Location'];
  const url = new URL(target.data);
  const spec = PROVIDER_SPECS[provider];
  const problems: string[] = [];
  const endpoint = `${url.origin}${url.pathname}`;
  if (endpoint !== spec.endpoints.authorization) {
    problems.push(`redirects to ${endpoint}; expected ${spec.endpoints.authorization}`);
  }
  const params = url.searchParams;
  const expectValue = (name: string, value: string) => {
    const values = params.getAll(name);
    if (values.length !== 1 || values[0] !== value) {
      problems.push(`${name} is ${values.join(', ') || 'absent'}; expected ${value}`);
    }
  };
  const expectSecretValue = (name: string, pattern: RegExp) => {
    const values = params.getAll(name);
    if (values.length !== 1 || !values.every(value => pattern.test(value))) {
      problems.push(`${name} is absent, repeated or malformed`);
    }
  };
  expectValue('response_type', 'code');
  expectValue('client_id', clientId);
  expectValue('redirect_uri', `${issuer}${utsProviderCallbackPath(provider)}`);
  expectValue('scope', spec.scope);
  expectSecretValue('state', /^\S+$/);
  if (usesPkce(spec)) {
    expectSecretValue('code_challenge', S256_CHALLENGE);
    expectValue('code_challenge_method', 'S256');
  } else if (params.has('code_challenge')) {
    problems.push('sends a code_challenge to a provider that offers no PKCE');
  }
  if (spec.protocol === 'oidc') {
    expectSecretValue('nonce', /^\S+$/);
    if (spec.resource !== null) expectValue('resource', spec.resource);
  }
  const binder = answer.setCookies.some(
    cookie =>
      BINDER_COOKIE.test(cookie) &&
      /;\s*Secure(;|$)/i.test(cookie) &&
      /;\s*HttpOnly(;|$)/i.test(cookie)
  );
  if (!binder) problems.push('sets no Secure, HttpOnly __Host-uts_flow_ binder cookie');
  return problems;
}

/** The public facts of a start that passed, for the proof's output. */
export function startSummary(answer: StartAnswer): string {
  const url = new URL(answer.location ?? '');
  const params = url.searchParams;
  const pkce = params.has('code_challenge') ? 'PKCE S256' : 'no PKCE (provider offers none)';
  return [
    `303 to ${url.origin}${url.pathname}`,
    `client_id ${params.get('client_id') ?? ''}`,
    `redirect_uri ${params.get('redirect_uri') ?? ''}`,
    pkce,
    params.has('nonce') ? 'nonce' : null,
    'binder cookie',
  ]
    .filter(part => part !== null)
    .join(', ');
}
