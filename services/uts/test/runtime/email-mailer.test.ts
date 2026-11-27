import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UtsConfig } from '../../src/env';
import { handleRequest } from '../../src/http';
import { emailSignIn, noticeEmailTransport } from '../../src/signin/email/delivery';
import { handleEmailRequest } from '../../src/signin/email/routes';
import { type SignInMethods, signInChoices } from '../../src/signin/flows';
import { type SignInEnv, readSignInConfig } from '../../src/signin/providers/config';
import type { ProviderSignInStore } from '../../src/signin/providers/store';
import { config, env } from './test-env';
import { noticeStep } from '../../src/scheduled';
import type { NoticeStore, NoticesAccess } from '../../src/notices/store';

/**
 * The email sign-in through the deployed sender: Cloudflare Turnstile's siteverify and Mailgun's
 * messages API as stand-ins that record each call and answer as told, the recipient rule of a
 * non-production environment, and the routes being off unless every mail setting is set.
 */

const ISSUER = config.endpoints.issuer;
const MAILGUN_KEY = 'synthetic-mailgun-sending-key';
const TURNSTILE_SECRET = 'synthetic-turnstile-secret';
const TOKEN = 'synthetic-turnstile-token';

const MAIL_ENV = {
  SIGNIN_EMAIL_HASH_KEY: 'A'.repeat(43),
  UTS_MAILGUN_SENDING_KEY: MAILGUN_KEY,
  UTS_MAILGUN_DOMAIN: 'mail.example.com',
  UTS_MAIL_FROM: 'Kilo <security@mail.example.com>',
  UTS_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  UTS_TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
  UTS_MAIL_ALLOWED_RECIPIENTS: '@example.com, tester@example.org',
} satisfies SignInEnv;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MESSAGES = 'https://api.mailgun.net/v3/mail.example.com/messages';

type StandInCall = { url: string; init: RequestInit | undefined };
type Answers = { siteverify: () => Response; mailgun: () => Response };

const passed = () =>
  Response.json({ success: true, hostname: 'localhost', action: 'email-sign-in' });
const accepted = () => Response.json({ id: '<id@mail.example.com>', message: 'Queued' });

/** Turnstile and Mailgun stand-ins behind one `fetch`; any other URL fails the test. */
function standIns(answers: Partial<Answers> = {}) {
  const calls: StandInCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === SITEVERIFY) return (answers.siteverify ?? passed)();
    if (url === MESSAGES) return (answers.mailgun ?? accepted)();
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetcher };
}

function storeRecording(withCode = true) {
  const calls: string[] = [];
  const unexpected = async () => {
    throw new Error('unexpected store call');
  };
  const store: ProviderSignInStore = {
    startFlow: unexpected,
    completeFlow: unexpected,
    readEmailLink: unexpected,
    completeEmailLink: unexpected,
    startEmail: async () => {
      calls.push('startEmail');
      return { outcome: 'stored', withCode, expiresAt: new Date('2026-11-27T12:10:00Z') };
    },
    verifyEmailCode: async () => {
      calls.push('verifyEmailCode');
      return { outcome: 'network_limited' };
    },
  };
  return { calls, store };
}

function methods(
  fetcher: typeof fetch,
  store: ProviderSignInStore,
  vars: SignInEnv = MAIL_ENV,
  utsConfig: UtsConfig = config
): SignInMethods {
  const settings = readSignInConfig(vars, utsConfig);
  return {
    config: utsConfig,
    settings,
    store: work => work(store),
    email: emailSignIn(settings, ISSUER, null, fetcher),
  };
}

let clientCounter = 0;
/** A form post from the issuer's page, each from its own client address (the start limiter). */
function start(fields: Record<string, string>) {
  clientCounter += 1;
  return new Request(`${ISSUER}/signin/email/start`, {
    method: 'POST',
    headers: {
      Origin: ISSUER,
      'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': `198.51.100.${clientCounter}`,
    },
    body: new URLSearchParams(fields),
  });
}

function formOf(call: StandInCall | undefined): FormData {
  const body = call?.init?.body;
  if (!(body instanceof FormData)) throw new Error('the Mailgun call carries no form');
  return body;
}

afterEach(() => vi.restoreAllMocks());

describe('email start with Turnstile and Mailgun', () => {
  it('checks the token once, stores the email, then sends one plain-text message', async () => {
    const { calls, fetcher } = standIns();
    const { calls: stored, store } = storeRecording();
    const response = await handleEmailRequest(
      start({ email: 'Person@Example.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, store)
    );
    expect(response?.status).toBe(200);
    expect(stored).toEqual(['startEmail']);
    expect(calls.map(call => call.url)).toEqual([SITEVERIFY, MESSAGES]);

    const verify = calls[0].init?.body;
    if (!(verify instanceof URLSearchParams)) throw new Error('siteverify takes a form');
    expect(Object.fromEntries(verify)).toEqual({
      secret: TURNSTILE_SECRET,
      response: TOKEN,
      remoteip: `198.51.100.${clientCounter}`,
    });

    const message = formOf(calls[1]);
    expect(new Headers(calls[1].init?.headers).get('Authorization')).toBe(
      `Basic ${btoa(`api:${MAILGUN_KEY}`)}`
    );
    expect(message.get('from')).toBe('Kilo <security@mail.example.com>');
    expect(message.getAll('to')).toEqual(['person@example.com']);
    expect(message.get('subject')).toBe('Sign in to Kilo');
    expect(message.get('o:tracking')).toBe('no');
    const text = String(message.get('text'));
    expect(text).toMatch(new RegExp(`${ISSUER}/signin/email/link\\?token=[A-Za-z0-9_-]{43}`));
    expect(text).toMatch(/enter this code on the sign-in page: \d{6}\n/);
    expect(text).toContain('until 12:10 UTC');
  });

  it('sends the link alone while codes are stopped', async () => {
    const { calls, fetcher } = standIns();
    await handleEmailRequest(
      start({ email: 'a@example.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, storeRecording(false).store)
    );
    const text = String(formOf(calls[1]).get('text'));
    expect(text).not.toContain('code');
    expect(text).toContain('The link works for 10 minutes');
  });

  it.each([
    ['no token', {}, undefined],
    [
      'a token Cloudflare refuses',
      { 'cf-turnstile-response': TOKEN },
      () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }),
    ],
    [
      'a token of another form',
      { 'cf-turnstile-response': TOKEN },
      () => Response.json({ success: true, hostname: 'localhost', action: 'other-form' }),
    ],
    [
      'a token of another site',
      { 'cf-turnstile-response': TOKEN },
      () => Response.json({ success: true, hostname: 'evil.example', action: 'email-sign-in' }),
    ],
  ])('refuses %s with 400 before anything is stored or sent', async (_case, token, answer) => {
    const { calls, fetcher } = standIns(answer === undefined ? {} : { siteverify: answer });
    const { calls: stored, store } = storeRecording();
    const response = await handleEmailRequest(
      start({ email: 'a@example.com', ...token }),
      '/signin/email/start',
      methods(fetcher, store)
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain('did not pass');
    expect(stored).toEqual([]);
    expect(calls.filter(call => call.url === MESSAGES)).toEqual([]);
    expect(calls.length).toBe(answer === undefined ? 0 : 1);
  });

  it.each([
    ['a 5xx', () => new Response('busy', { status: 503 })],
    ['internal-error', () => Response.json({ success: false, 'error-codes': ['internal-error'] })],
    ['an answer that is not JSON', () => new Response('<html>')],
  ])('answers 503 with Retry-After when siteverify gives %s', async (_case, siteverify) => {
    const { calls, fetcher } = standIns({ siteverify });
    const { calls: stored, store } = storeRecording();
    const response = await handleEmailRequest(
      start({ email: 'a@example.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, store)
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('2');
    expect(stored).toEqual([]);
    expect(calls.map(call => call.url)).toEqual([SITEVERIFY]);
  });

  it('answers 503 when siteverify cannot be reached', async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('network down');
    };
    const response = await handleEmailRequest(
      start({ email: 'a@example.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, storeRecording().store)
    );
    expect(response?.status).toBe(503);
  });

  it('answers 500 and logs names only when Cloudflare refuses the secret', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetcher } = standIns({
      siteverify: () => Response.json({ success: false, 'error-codes': ['invalid-input-secret'] }),
    });
    const response = await handleEmailRequest(
      start({ email: 'a@example.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, storeRecording().store)
    );
    expect(response?.status).toBe(500);
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).toContain('UTS_TURNSTILE_SECRET_KEY');
    expect(logged).toContain('invalid-input-secret');
    for (const value of [TURNSTILE_SECRET, TOKEN, MAILGUN_KEY]) {
      expect(logged).not.toContain(value);
    }
  });

  it('answers 503 when Mailgun fails retryably and 502 when it refuses, after the store', async () => {
    for (const [status, page] of [
      [429, 503],
      [500, 503],
      [400, 502],
      [401, 502],
    ] as const) {
      const { calls, fetcher } = standIns({
        mailgun: () => new Response('no', { status }),
      });
      const { calls: stored, store } = storeRecording();
      const response = await handleEmailRequest(
        start({ email: 'a@example.com', 'cf-turnstile-response': TOKEN }),
        '/signin/email/start',
        methods(fetcher, store)
      );
      expect(response?.status).toBe(page);
      expect(stored).toEqual(['startEmail']);
      expect(calls.map(call => call.url)).toEqual([SITEVERIFY, MESSAGES]);
    }
  });
});

describe('recipient rule', () => {
  it('refuses an address outside the allow-list after the Turnstile check, without a row or a message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls, fetcher } = standIns();
    const { calls: stored, store } = storeRecording();
    for (const email of ['person@gmail.com', 'other@example.org', 'a@sub.example.com']) {
      const response = await handleEmailRequest(
        start({ email, 'cf-turnstile-response': TOKEN }),
        '/signin/email/start',
        methods(fetcher, store)
      );
      expect(response?.status).toBe(403);
      expect(await response?.text()).toContain('only to test addresses');
    }
    expect(calls.map(call => call.url)).toEqual([SITEVERIFY, SITEVERIFY, SITEVERIFY]);
    expect(stored).toEqual([]);
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).toContain('uts.signin.mail_recipient_refused');
    expect(logged).not.toContain('gmail.com');
  });

  it('tells nobody without a passing Turnstile token whether an address is allowed', async () => {
    const { fetcher } = standIns({
      siteverify: () =>
        Response.json({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const statuses = [];
    for (const email of ['person@gmail.com', 'someone@example.com']) {
      const response = await handleEmailRequest(
        start({ email, 'cf-turnstile-response': TOKEN }),
        '/signin/email/start',
        methods(fetcher, storeRecording().store)
      );
      statuses.push(response?.status);
    }
    expect(statuses).toEqual([400, 400]);
  });

  it('sends to an allowed domain and to an allowed address', async () => {
    for (const email of ['someone@example.com', 'Tester@Example.org']) {
      const { calls, fetcher } = standIns();
      const response = await handleEmailRequest(
        start({ email, 'cf-turnstile-response': TOKEN }),
        '/signin/email/start',
        methods(fetcher, storeRecording().store)
      );
      expect(response?.status).toBe(200);
      expect(formOf(calls[1]).getAll('to')).toEqual([email.toLowerCase()]);
    }
  });

  it.each([
    'x <someone@example.com>',
    'someone@example.com, other@example.com',
    'a,b@example.com',
    '"a b"@example.com',
    'someone@example.com;other@example.com',
    '(comment)someone@example.com',
    'someone@example..com',
    'someone@-example.com',
  ])('refuses the address %j before any call, row or message', async email => {
    const { calls, fetcher } = standIns();
    const { calls: stored, store } = storeRecording();
    const response = await handleEmailRequest(
      start({ email, 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, store)
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain('Enter a valid email address');
    expect(calls).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('makes Mailgun drop each recipient that is not a plain address, as a second layer', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls, fetcher } = standIns();
    const { UTS_MAIL_ALLOWED_RECIPIENTS: _allowList, ...productionVars } = MAIL_ENV;
    const mail = readSignInConfig(productionVars, { ...config, environment: 'production' }).mail;
    const transport = noticeEmailTransport(mail, fetcher);
    if (transport === null) throw new Error('mail settings are on');
    const notice = { subject: 'New sign-in', text: 'A new sign-in to your account.' };
    // Nothing valid left: no call.
    expect(await transport({ ...notice, to: ['x <victim@example.net>'] })).toBe('no_target');
    expect(calls).toEqual([]);
    // One valid, one not: the valid one goes out alone, in its own letter case.
    expect(await transport({ ...notice, to: ['Owner@Example.com', 'a,b@example.net'] })).toBe(
      'sent'
    );
    expect(calls).toHaveLength(1);
    const form = formOf(calls[0]);
    expect(form.getAll('to')).toEqual(['Owner@Example.com']);
    expect(JSON.parse(String(form.get('recipient-variables')))).toEqual({
      'Owner@Example.com': {},
    });
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).toContain('"dropped":1');
    expect(logged).not.toContain('victim@example.net');
    expect(logged).not.toContain('a,b@example.net');
  });

  it('lets the notice email go only to allowed addresses, and to none answers no_target', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { calls, fetcher } = standIns();
    const mail = readSignInConfig(MAIL_ENV, config).mail;
    const transport = noticeEmailTransport(mail, fetcher);
    if (transport === null) throw new Error('mail settings are on');
    const notice = { subject: 'New sign-in', text: 'A new sign-in to your account.' };
    expect(await transport({ ...notice, to: ['owner@example.com', 'old@gmail.com'] })).toBe('sent');
    expect(formOf(calls[0]).getAll('to')).toEqual(['owner@example.com']);
    expect(await transport({ ...notice, to: ['old@gmail.com'] })).toBe('no_target');
    expect(calls).toHaveLength(1);
  });

  it('sends to any address in production, where an allow-list is a deploy error', async () => {
    const production: UtsConfig = { ...config, environment: 'production' };
    const { UTS_MAIL_ALLOWED_RECIPIENTS: _allowList, ...productionVars } = MAIL_ENV;
    expect(readSignInConfig(productionVars, production).mail).toMatchObject({
      status: 'on',
      recipients: { kind: 'any' },
    });
    expect(readSignInConfig(MAIL_ENV, production).mail).toEqual({
      status: 'misconfigured',
      missing: ['UTS_MAIL_ALLOWED_RECIPIENTS'],
    });
    const { calls, fetcher } = standIns();
    const response = await handleEmailRequest(
      start({ email: 'person@gmail.com', 'cf-turnstile-response': TOKEN }),
      '/signin/email/start',
      methods(fetcher, storeRecording().store, productionVars, production)
    );
    expect(response?.status).toBe(200);
    expect(formOf(calls[1]).getAll('to')).toEqual(['person@gmail.com']);
  });
});

describe('notice step of the cron', () => {
  function noticeStore() {
    const calls: string[] = [];
    const unexpected = async () => {
      throw new Error('unexpected notice store call');
    };
    const store: NoticeStore = {
      claimNotice: unexpected,
      claimCredentialNotice: unexpected,
      finishNotice: unexpected,
      claimDueNotices: async () => {
        calls.push('claimDueNotices');
        return [];
      },
      maintainNoticeRows: async () => {
        calls.push('maintainNoticeRows');
        return [];
      },
    };
    const notices: NoticesAccess = work => work(store);
    return { calls, notices };
  }

  it('claims nothing while the mail settings are misconfigured, so email stays unsettled', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { UTS_MAILGUN_SENDING_KEY: _key, ...vars } = MAIL_ENV;
    const mail = readSignInConfig(vars, config).mail;
    expect(mail.status).toBe('misconfigured');
    const { calls, notices } = noticeStore();
    const { calls: sent, fetcher } = standIns();
    await noticeStep(mail, notices, fetcher);
    // No claim, so no round can settle a due notice's email as not_configured; retention runs.
    expect(calls).toEqual(['maintainNoticeRows']);
    expect(sent).toEqual([]);
    expect(errors.mock.calls.flat().join('\n')).toContain('UTS_MAILGUN_SENDING_KEY');
  });

  it('runs the sweep when mail is off or on', async () => {
    for (const vars of [{}, MAIL_ENV]) {
      const { calls, notices } = noticeStore();
      await noticeStep(readSignInConfig(vars, config).mail, notices, standIns().fetcher);
      expect(calls).toEqual(['claimDueNotices', 'maintainNoticeRows']);
    }
  });
});

describe('wrong codes per network', () => {
  it('answers 429 and points to the link when the network is at its limit', async () => {
    const { calls, store } = storeRecording();
    const response = await handleEmailRequest(
      new Request(`${ISSUER}/signin/email/code`, {
        method: 'POST',
        headers: { Origin: ISSUER, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40example.com&code=123456',
      }),
      '/signin/email/code',
      methods(standIns().fetcher, store)
    );
    expect(response?.status).toBe(429);
    expect(await response?.text()).toContain('Use the link in the email');
    expect(calls).toEqual(['verifyEmailCode']);
  });
});

describe('switching the email sign-in on', () => {
  const required = [
    'UTS_MAILGUN_SENDING_KEY',
    'UTS_MAILGUN_DOMAIN',
    'UTS_MAIL_FROM',
    'UTS_TURNSTILE_SITE_KEY',
    'UTS_TURNSTILE_SECRET_KEY',
  ] as const;

  function post(vars: SignInEnv) {
    return handleRequest(
      new Request(`${ISSUER}/signin/email/start`, {
        method: 'POST',
        headers: { Origin: ISSUER, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40example.com',
      }),
      { ...env, ...vars },
      createExecutionContext()
    );
  }

  it('offers it, with the widget, only when every mail setting is set', () => {
    const { fetcher } = standIns();
    const { store } = storeRecording();
    expect(signInChoices(methods(fetcher, store), '/signin/done').email).toEqual({
      turnstileSiteKey: '1x00000000000000000000AA',
    });
    for (const name of required) {
      const { [name]: _dropped, ...vars } = MAIL_ENV;
      expect(signInChoices(methods(fetcher, store, vars), '/signin/done').email).toBeNull();
    }
  });

  it('serves no route without any mail setting, even with the hash key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await post({ SIGNIN_EMAIL_HASH_KEY: MAIL_ENV.SIGNIN_EMAIL_HASH_KEY });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays off with the secrets alone, so they can be set before the vars deploy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await post({
      SIGNIN_EMAIL_HASH_KEY: MAIL_ENV.SIGNIN_EMAIL_HASH_KEY,
      UTS_MAILGUN_SENDING_KEY: MAILGUN_KEY,
      UTS_TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    });
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(required)('answers 500 without %s, sends nothing and logs the name only', async name => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { [name]: _dropped, ...vars } = MAIL_ENV;
    const response = await post(vars);
    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).toContain(name);
    for (const value of [MAILGUN_KEY, TURNSTILE_SECRET]) expect(logged).not.toContain(value);
  });

  it.each([
    ['no allow-list outside production', { UTS_MAIL_ALLOWED_RECIPIENTS: undefined }],
    ['a bad allow-list entry', { UTS_MAIL_ALLOWED_RECIPIENTS: 'example.com' }],
    ['a sender off the sending domain', { UTS_MAIL_FROM: 'Kilo <security@other.example>' }],
    [
      'a sender with a line break',
      { UTS_MAIL_FROM: 'Kilo\r\nBcc: x@example.com <a@mail.example.com>' },
    ],
    ['a site key that is not a key', { UTS_TURNSTILE_SITE_KEY: 'key" onload="x' }],
    ['a domain that is not a domain', { UTS_MAILGUN_DOMAIN: 'mail.example.com/x' }],
  ])('treats %s as a deploy error', (_case, change) => {
    expect(readSignInConfig({ ...MAIL_ENV, ...change }, config).mail.status).toBe('misconfigured');
  });

  it('needs the hash key once the mail settings are on', () => {
    const { SIGNIN_EMAIL_HASH_KEY: _key, ...vars } = MAIL_ENV;
    const settings = readSignInConfig(vars, config);
    expect(emailSignIn(settings, ISSUER, null, standIns().fetcher)).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_EMAIL_HASH_KEY'],
    });
  });

  it('uses Mailgun and Turnstile in the development entry too once the mail settings are set', () => {
    const settings = readSignInConfig(MAIL_ENV, config);
    const recording = async () => 'sent' as const;
    expect(emailSignIn(settings, ISSUER, recording, standIns().fetcher)).toMatchObject({
      status: 'on',
      delivery: { kind: 'mailgun' },
    });
    const keyOnly = readSignInConfig({ SIGNIN_EMAIL_HASH_KEY: 'A'.repeat(43) }, config);
    expect(emailSignIn(keyOnly, ISSUER, recording, standIns().fetcher)).toMatchObject({
      status: 'on',
      delivery: { kind: 'recording' },
    });
    expect(emailSignIn(keyOnly, ISSUER, null, standIns().fetcher)).toEqual({ status: 'off' });
    // A bad hash key is a deploy error only where a sender is wired.
    const badKey = readSignInConfig({ SIGNIN_EMAIL_HASH_KEY: 'not-a-key' }, config);
    expect(emailSignIn(badKey, ISSUER, null, standIns().fetcher)).toEqual({ status: 'off' });
    expect(emailSignIn(badKey, ISSUER, recording, standIns().fetcher)).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_EMAIL_HASH_KEY'],
    });
  });

  it('takes local Mailgun and Turnstile stand-ins only from the development endpoints', () => {
    const endpoints = JSON.stringify({
      mail: { mailgun: 'http://127.0.0.1:9503', turnstile: 'http://127.0.0.1:9503/siteverify' },
    });
    const mail = readSignInConfig({ ...MAIL_ENV, SIGNIN_DEV_ENDPOINTS: endpoints }, config).mail;
    expect(mail).toMatchObject({
      status: 'on',
      mailgun: { baseUrl: 'http://127.0.0.1:9503' },
      turnstile: { verifyUrl: 'http://127.0.0.1:9503/siteverify' },
    });
    const staging: UtsConfig = { ...config, environment: 'staging' };
    expect(
      readSignInConfig({ ...MAIL_ENV, SIGNIN_DEV_ENDPOINTS: endpoints }, staging).mail
    ).toEqual({ status: 'misconfigured', missing: ['SIGNIN_DEV_ENDPOINTS'] });
  });
});
