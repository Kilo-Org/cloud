import { describe, expect, it } from 'vitest';
import {
  pageProblems,
  parseExpectedProviders,
  providersOnPage,
  startProblems,
  startSummary,
  type StartAnswer,
} from '../../scripts/provider-start';

/** The checks of the provider sign-in proof (scripts/provider-signin-proof.ts), on synthetic answers. */

const ISSUER = 'https://uts-staging.kiloapps.io';
const CHALLENGE = 'A'.repeat(43);
const BINDER =
  '__Host-uts_flow_0123456789abcdef=binder; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=None';

function answer(location: string, edit: Partial<StartAnswer> = {}): StartAnswer {
  return { status: 303, location, setCookies: [BINDER], ...edit };
}

function githubLocation(params: Record<string, string> = {}): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  const values = {
    response_type: 'code',
    client_id: 'github-client',
    redirect_uri: `${ISSUER}/signin/oauth/github/callback`,
    scope: 'read:user user:email',
    state: 'state-value',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...params,
  };
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url.toString();
}

describe('expected providers', () => {
  it('reads provider=client id pairs, and none from an empty value', () => {
    expect([
      ...parseExpectedProviders('github=Ov23abc, google=1-a.apps.googleusercontent.com'),
    ]).toEqual([
      ['github', 'Ov23abc'],
      ['google', '1-a.apps.googleusercontent.com'],
    ]);
    expect(parseExpectedProviders('').size).toBe(0);
  });

  it('refuses an unknown provider, a missing client id and a provider named twice', () => {
    expect(() => parseExpectedProviders('myspace=abc')).toThrow();
    expect(() => parseExpectedProviders('github')).toThrow();
    expect(() => parseExpectedProviders('github=a b')).toThrow();
    expect(() => parseExpectedProviders('github=a,github=b')).toThrow('twice');
  });
});

describe('the sign-in page', () => {
  const html =
    '<ul><li><a href="/signin/oauth/google/start?return_to=%2Fsignin%2Fpasskeys">Google</a></li>' +
    '<li><a href="/signin/oauth/github/start?return_to=%2Fsignin%2Fpasskeys">GitHub</a></li></ul>';

  it('passes when it offers exactly the expected providers', () => {
    const listed = providersOnPage(html);
    expect(listed).toEqual(['google', 'github']);
    expect(pageProblems(listed, parseExpectedProviders('github=a,google=b'))).toEqual([]);
  });

  it('passes a page with no provider when none is expected', () => {
    expect(pageProblems(providersOnPage('<main></main>'), parseExpectedProviders(''))).toEqual([]);
  });

  it('fails a missing and an unexpected provider', () => {
    expect(
      pageProblems(providersOnPage(html), parseExpectedProviders('github=a,gitlab=c'))
    ).toEqual(['does not offer gitlab', 'offers google beyond the expected']);
  });
});

describe('a provider start', () => {
  it('passes the redirect the issuer sends, and summarizes only public values', () => {
    const start = answer(githubLocation());
    expect(startProblems(ISSUER, 'github', 'github-client', start)).toEqual([]);
    const summary = startSummary(start);
    expect(summary).toBe(
      `303 to https://github.com/login/oauth/authorize, client_id github-client, redirect_uri ${ISSUER}/signin/oauth/github/callback, PKCE S256, binder cookie`
    );
    expect(summary).not.toContain('state-value');
    expect(summary).not.toContain(CHALLENGE);
  });

  it('requires the nonce of an OpenID Connect provider', () => {
    const url = new URL('https://gitlab.com/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'gitlab-client');
    url.searchParams.set('redirect_uri', `${ISSUER}/signin/oauth/gitlab/callback`);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', 'state-value');
    url.searchParams.set('code_challenge', CHALLENGE);
    url.searchParams.set('code_challenge_method', 'S256');
    expect(startProblems(ISSUER, 'gitlab', 'gitlab-client', answer(url.toString()))).toEqual([
      'nonce is absent, repeated or malformed',
    ]);
    url.searchParams.set('nonce', 'nonce-value');
    expect(startProblems(ISSUER, 'gitlab', 'gitlab-client', answer(url.toString()))).toEqual([]);
  });

  it('fails another host, client id, redirect URI or PKCE method without naming a secret value', () => {
    const location = githubLocation({
      client_id: 'other-client',
      redirect_uri: 'https://uts.kiloapps.io/signin/oauth/github/callback',
      code_challenge_method: 'plain',
      code_challenge: 'short',
    }).replace('https://github.com/', 'https://github.example/');
    const problems = startProblems(ISSUER, 'github', 'github-client', answer(location));
    expect(problems).toEqual([
      'redirects to https://github.example/login/oauth/authorize; expected https://github.com/login/oauth/authorize',
      'client_id is other-client; expected github-client',
      `redirect_uri is https://uts.kiloapps.io/signin/oauth/github/callback; expected ${ISSUER}/signin/oauth/github/callback`,
      'code_challenge is absent, repeated or malformed',
      'code_challenge_method is plain; expected S256',
    ]);
    expect(problems.join('\n')).not.toContain('short');
  });

  it('fails a start without the binder cookie or with a cookie script can read', () => {
    const location = githubLocation();
    const problem = 'sets no Secure, HttpOnly __Host-uts_flow_ binder cookie';
    expect(
      startProblems(ISSUER, 'github', 'github-client', answer(location, { setCookies: [] }))
    ).toEqual([problem]);
    const readable = BINDER.replace('; HttpOnly', '');
    expect(
      startProblems(ISSUER, 'github', 'github-client', answer(location, { setCookies: [readable] }))
    ).toEqual([problem]);
  });

  it('fails a start that does not redirect, such as a misconfigured or unavailable provider', () => {
    expect(startProblems(ISSUER, 'github', 'github-client', answer('', { status: 500 }))).toEqual([
      'answers 500; expected 303',
    ]);
    expect(startProblems(ISSUER, 'github', 'github-client', answer('', { status: 503 }))).toEqual([
      'answers 503; expected 303',
    ]);
    expect(
      startProblems(ISSUER, 'github', 'github-client', answer('', { location: null }))
    ).toEqual(['answers 303 without a valid Location']);
  });
});
