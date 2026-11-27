import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../src/http';
import type { SignInEmail } from '../../src/signin/email/mailer';
import { handleEmailRequest } from '../../src/signin/email/routes';
import { type SignInMethods, flowCookieName } from '../../src/signin/flows';
import { signInPage } from '../../src/signin/pages';
import { readSignInConfig } from '../../src/signin/providers/config';
import { handleProviderRequest } from '../../src/signin/providers/routes';
import type { ProviderSignInStore } from '../../src/signin/providers/store';
import { handleSsoRequest } from '../../src/signin/sso/routes';
import { sha256 } from '../../src/token/credentials';
import { config, env } from './test-env';

/**
 * The sign-in routes of providers, SSO and email against a recording store: what each request
 * stores, the cookies and redirects it answers with, and the requests it refuses before any
 * statement runs.
 */

const ISSUER = config.endpoints.issuer;
const HASH_KEY = 'A'.repeat(43);

type Call = { method: keyof ProviderSignInStore; input: unknown };

function methodsWith(implementation: Partial<ProviderSignInStore>, mail: SignInEmail[] = []) {
  const calls: Call[] = [];
  const record =
    <Input, Output>(method: keyof ProviderSignInStore, run?: (input: Input) => Promise<Output>) =>
    async (input: Input): Promise<Output> => {
      calls.push({ method, input });
      if (run === undefined) throw new Error(`unexpected ${method} call`);
      return await run(input);
    };
  const store: ProviderSignInStore = {
    startFlow: record('startFlow', implementation.startFlow),
    completeFlow: record('completeFlow', implementation.completeFlow),
    startEmail: record('startEmail', implementation.startEmail),
    verifyEmailCode: record('verifyEmailCode', implementation.verifyEmailCode),
    completeEmailLink: record('completeEmailLink', implementation.completeEmailLink),
    readEmailLink: record('readEmailLink', implementation.readEmailLink),
  };
  const methods: SignInMethods = {
    config,
    settings: readSignInConfig(
      {
        SIGNIN_GOOGLE_CLIENT_ID: 'google-client',
        SIGNIN_GOOGLE_CLIENT_SECRET: 'google-secret',
        SIGNIN_APPLE_CLIENT_ID: 'apple-client',
        SIGNIN_APPLE_TEAM_ID: 'TEAM',
        SIGNIN_WORKOS_CLIENT_ID: 'client_workos',
        SIGNIN_WORKOS_API_KEY: 'sk_test',
        SIGNIN_EMAIL_HASH_KEY: HASH_KEY,
      },
      config
    ),
    store: work => work(store),
    mailer: async message => {
      mail.push(message);
      return 'sent';
    },
  };
  return { methods, calls };
}

/** The cookies a response sets; each is a `__Host-` cookie without `Expires`, so this split holds. */
function setCookies(response: Response): string[] {
  return (response.headers.get('Set-Cookie') ?? '').split(/,\s*(?=__Host-)/);
}

afterEach(() => vi.restoreAllMocks());

describe('provider routes', () => {
  it('stores a flow and redirects to the provider with the binder cookie', async () => {
    const { methods, calls } = methodsWith({
      startFlow: async () => ({ outcome: 'started', workosConnectionId: null }),
    });
    const response = await handleProviderRequest(
      new Request(
        `${ISSUER}/signin/oauth/google/start?return_to=%2Fauthorize%3Fclient_id%3Dkilo-cli`
      ),
      '/signin/oauth/google/start',
      methods
    );
    expect(response?.status).toBe(303);
    const location = new URL(response?.headers.get('Location') ?? '');
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${ISSUER}/signin/oauth/google/callback`
    );
    const state = location.searchParams.get('state') ?? '';
    const [cookie] = setCookies(response ?? new Response());
    expect(cookie).toMatch(
      new RegExp(
        `^${flowCookieName(await sha256(state))}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=None$`
      )
    );
    expect(calls).toMatchObject([
      {
        method: 'startFlow',
        input: {
          provider: 'google',
          intent: { kind: 'sign_in' },
          returnTo: '/authorize?client_id=kilo-cli',
        },
      },
    ]);
  });

  it('serves no route for a provider that is not configured, and 500 for a partial one', async () => {
    const { methods } = methodsWith({});
    expect(
      await handleProviderRequest(
        new Request(`${ISSUER}/signin/oauth/github/start`),
        '/signin/oauth/github/start',
        methods
      )
    ).toBeNull();
    const partial = await handleProviderRequest(
      new Request(`${ISSUER}/signin/oauth/apple/start`),
      '/signin/oauth/apple/start',
      methods
    );
    expect(partial?.status).toBe(500);
  });

  it('refuses a callback without the binder before any provider or store call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { methods, calls } = methodsWith({});
    const response = await handleProviderRequest(
      new Request(`${ISSUER}/signin/oauth/google/callback?code=c&state=${'S'.repeat(43)}`),
      '/signin/oauth/google/callback',
      methods
    );
    expect(response?.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('starts a link only with a session cookie and a gate pass id', async () => {
    const { methods, calls } = methodsWith({});
    const response = await handleProviderRequest(
      new Request(
        `${ISSUER}/signin/oauth/google/start?intent=link&gate_pass=${crypto.randomUUID()}`
      ),
      '/signin/oauth/google/start',
      methods
    );
    expect(response?.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('SSO routes', () => {
  it('starts with the domain of the address and answers a page that navigates to WorkOS', async () => {
    const { methods, calls } = methodsWith({
      startFlow: async () => ({ outcome: 'started', workosConnectionId: 'conn_1' }),
    });
    const response = await handleSsoRequest(
      new Request(`${ISSUER}/signin/sso/start`, {
        method: 'POST',
        headers: { Origin: ISSUER, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=Person%40Corp.Example&return_to=%2Fsignin%2Fdone',
      }),
      '/signin/sso/start',
      methods
    );
    // No redirect: a form submission's redirect chain would put WorkOS's own redirect to the
    // org's identity provider under the sign-in page's form-action.
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Location')).toBeNull();
    expect(response?.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
    expect(response?.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(setCookies(response ?? new Response())[0]).toMatch(/^__Host-uts_flow_[0-9a-f]{16}=/);
    const html = (await response?.text()) ?? '';
    const target = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1] ?? '';
    const location = new URL(target.replaceAll('&amp;', '&'));
    expect(location.origin + location.pathname).toBe('https://api.workos.com/sso/authorize');
    expect(location.searchParams.get('connection')).toBe('conn_1');
    expect(html).toContain('id="continue"');
    expect(calls).toMatchObject([
      { method: 'startFlow', input: { provider: 'workos', ssoDomain: 'corp.example' } },
    ]);
  });

  it('refuses a start posted from another site', async () => {
    const { methods, calls } = methodsWith({});
    const response = await handleSsoRequest(
      new Request(`${ISSUER}/signin/sso/start`, {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'email=a%40corp.example',
      }),
      '/signin/sso/start',
      methods
    );
    expect(response?.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('email routes', () => {
  function post(path: string, body: string, origin = ISSUER) {
    return new Request(`${ISSUER}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }

  it('stores the hashes first, then mails the link and the code', async () => {
    const mail: SignInEmail[] = [];
    const { methods, calls } = methodsWith(
      {
        startEmail: async () => ({
          outcome: 'stored',
          withCode: true,
          expiresAt: new Date(Date.now() + 600_000),
        }),
      },
      mail
    );
    const response = await handleEmailRequest(
      post('/signin/email/start', 'email=Person%40Example.com&return_to=%2Fsignin%2Fdone'),
      '/signin/email/start',
      methods
    );
    expect(response?.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('person@example.com');
    expect(mail[0].code).toMatch(/^\d{6}$/);
    const link = new URL(mail[0].link);
    expect(link.origin + link.pathname).toBe(`${ISSUER}/signin/email/link`);
    const stored = calls[0].input;
    expect(stored).toMatchObject({ email: 'person@example.com', returnTo: '/signin/done' });
    // Neither the code nor the link token reaches the store in clear.
    expect(JSON.stringify(stored)).not.toContain(mail[0].code ?? '');
    expect(JSON.stringify(stored)).not.toContain(link.searchParams.get('token') ?? '');
  });

  it('mails the link alone while codes are stopped', async () => {
    const mail: SignInEmail[] = [];
    const { methods } = methodsWith(
      {
        startEmail: async () => ({ outcome: 'stored', withCode: false, expiresAt: new Date() }),
      },
      mail
    );
    await handleEmailRequest(
      post('/signin/email/start', 'email=a%40example.com'),
      '/signin/email/start',
      methods
    );
    expect(mail[0].code).toBeNull();
  });

  it('mails nothing and answers 429 once the link-only emails of the hour are spent', async () => {
    const mail: SignInEmail[] = [];
    const { methods } = methodsWith(
      { startEmail: async () => ({ outcome: 'send_limited' }) },
      mail
    );
    const response = await handleEmailRequest(
      post('/signin/email/start', 'email=a%40example.com'),
      '/signin/email/start',
      methods
    );
    expect(response?.status).toBe(429);
    expect(await response?.text()).toContain('Too many sign-in emails');
    expect(response?.headers.get('Set-Cookie')).toBeNull();
    expect(mail).toEqual([]);
  });

  it('shows the address on the link page, warns in another browser, and consumes nothing', async () => {
    const { methods, calls } = methodsWith({
      readEmailLink: async () => ({ email: 'person@example.com', binderHash: new Uint8Array(32) }),
    });
    const token = 'T'.repeat(43);
    const response = await handleEmailRequest(
      new Request(`${ISSUER}/signin/email/link?token=${token}`),
      '/signin/email/link',
      methods
    );
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).toContain('p…@example.com');
    // This request carries no binder cookie of the email, so the page warns and confirms.
    expect(html).toContain('another browser');
    expect(calls.map(call => call.method)).toEqual(['readEmailLink']);
  });

  it('signs in with the right code and sets the session cookie', async () => {
    const { methods } = methodsWith({
      verifyEmailCode: async () => ({
        outcome: 'signed_in',
        returnTo: '/authorize?client_id=kilo-cli',
        signedIn: {
          sessionId: crypto.randomUUID(),
          accountId: 'a',
          accountCreated: false,
          methodLinked: false,
        },
      }),
    });
    const response = await handleEmailRequest(
      post('/signin/email/code', 'email=a%40example.com&code=123456'),
      '/signin/email/code',
      methods
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get('Location')).toBe('/authorize?client_id=kilo-cli');
    expect(setCookies(response ?? new Response())[0]).toMatch(/^__Host-uts_session=/);
  });

  it('tells the user how many tries are left, and refuses a code posted from another site', async () => {
    const { methods } = methodsWith({
      verifyEmailCode: async () => ({
        outcome: 'invalid_code',
        entriesLeft: 2,
        returnTo: '/signin/done',
      }),
    });
    const wrong = await handleEmailRequest(
      post('/signin/email/code', 'email=a%40example.com&code=000000'),
      '/signin/email/code',
      methods
    );
    expect(wrong?.status).toBe(400);
    expect(await wrong?.text()).toContain('2 tries left');
    const foreign = await handleEmailRequest(
      post('/signin/email/code', 'email=a%40example.com&code=000000', 'https://evil.example'),
      '/signin/email/code',
      methods
    );
    expect(foreign?.status).toBe(403);
  });
});

describe('sign-in page', () => {
  it('lists the configured methods, and its form-action stays on the issuer', async () => {
    const response = signInPage({
      returnTo: '/authorize?client_id=kilo-cli&state=a"b',
      rpId: 'app.kilo.ai',
      providers: [{ provider: 'google', name: 'Google' }],
      email: true,
      sso: true,
    });
    const html = await response.text();
    expect(html).toContain(
      'href="/signin/oauth/google/start?return_to=%2Fauthorize%3Fclient_id%3Dkilo-cli%26state%3Da%22b"'
    );
    expect(html).toContain('value="/authorize?client_id=kilo-cli&amp;state=a&quot;b"');
    expect(html).toContain('action="/signin/sso/start"');
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'self';");
  });
});

describe('configuration', () => {
  it('keeps the token and metadata routes working with a bad sign-in setting', async () => {
    const badEnv = { ...env, SIGNIN_EMAIL_HASH_KEY: 'not-a-key', SIGNIN_DEV_ENDPOINTS: '{' };
    const ctx = createExecutionContext();
    const metadata = await handleRequest(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      badEnv,
      ctx
    );
    expect(metadata.status).toBe(200);
    const token = await handleRequest(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=unknown',
      }),
      badEnv,
      ctx
    );
    expect(token.status).toBe(400);
    const settings = readSignInConfig(badEnv, config);
    expect(settings.emailHashKey).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_EMAIL_HASH_KEY'],
    });
  });
});
