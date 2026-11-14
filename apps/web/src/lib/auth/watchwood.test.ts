import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import {
  assessWatchwoodSignup,
  checkWatchwoodSignup,
  prepareWatchwoodSignupSession,
  readWatchwoodSignupContext,
  recordWatchwoodSignupShadow,
  type WatchwoodSignupAssessment,
} from './watchwood';

const mockCookieValues = new Map<string, string>();
const mockDelete = jest.fn((name: string) => mockCookieValues.delete(name));
const mockEval = jest.fn();
const mockSet = jest.fn();
const mockGetdel = jest.fn();
const mockTokens = new Map<string, string>();
jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({
    get: (name: string) => {
      const value = mockCookieValues.get(name);
      return value ? { value } : undefined;
    },
    delete: (name: string) => mockDelete(name),
  })),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'watchwood-unit-test-signing-key',
  NEXTAUTH_URL: 'https://example.test',
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    eval: (...args: unknown[]) => mockEval(...args),
    set: (...args: unknown[]) => mockSet(...args),
    getdel: (...args: unknown[]) => mockGetdel(...args),
  },
}));

const secret = 'watchwood-unit-test-signing-key';
const sessionCookie = 'watchwood_signup_session';
const guid = '4829b420-d43c-4f31-893d-f5042cf274cf';
const otherGuid = '0f4d7b9a-2c1e-4a55-9d1b-6a1f6f0c3a10';
const ip = '192.0.2.10';
const browserToken = 'synthetic-watchwood-token';
const createAccountUrl = 'https://api.openai.com/v1/watchwood/check/create_account';
const originalFetch = global.fetch;
const originalEnv = process.env;
let mockFetch: jest.Mock;
let info: jest.SpyInstance;

function signed(value: object, audience?: string) {
  return jwt.sign(value, secret, {
    algorithm: 'HS256',
    expiresIn: 3600,
    ...(audience ? { audience } : {}),
  });
}

function request(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://example.test/api/auth/watchwood', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: [...mockCookieValues].map(([name, value]) => `${name}=${value}`).join('; '),
      'x-forwarded-for': ip,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function session() {
  const result = await prepareWatchwoodSignupSession(request());
  const data = await result.json();
  const value = result.cookies.get(sessionCookie)?.value;
  expect(value).toBeDefined();
  mockCookieValues.set(sessionCookie, value ?? '');
  mockCookieValues.set('turnstile_jwt', signed({ guid, ip }));
  return data.safety_identifier as string;
}

function storedRecord() {
  const call = mockSet.mock.calls.at(-1);
  expect(call).toBeDefined();
  const [key, value, options] = call as [string, string, { ex: number }];
  return { key, value: JSON.parse(value), options };
}

function logEntry(name: string): Record<string, unknown> | undefined {
  const call = info.mock.calls.find(([event]) => event === name);
  return call?.[1] as Record<string, unknown> | undefined;
}

async function tokenFor(identity: string, token = browserToken) {
  await assessWatchwoodSignup(request({ token, safety_identifier: identity }));
}

function check(identity: string, options: { email?: string; ip?: string; guid?: string } = {}) {
  return checkWatchwoodSignup({
    operationId: 'operation',
    context: { safetyIdentifier: identity, turnstileGuid: options.guid ?? guid },
    email: options.email ?? 'user@example.com',
    ip: options.ip ?? ip,
  });
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    WATCHWOOD_SHADOW_ENABLED: 'true',
    WATCHWOOD_ORG_ID: 'test-org',
    WATCHWOOD_API_KEY: 'synthetic-api-key',
  };
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  mockCookieValues.clear();
  mockTokens.clear();
  jest.clearAllMocks();
  mockEval.mockResolvedValue(1);
  mockSet.mockImplementation(async (key: string, value: string) => {
    mockTokens.set(key, value);
    return 'OK';
  });
  mockGetdel.mockImplementation(async (key: string) => {
    const value = mockTokens.get(key) ?? null;
    mockTokens.delete(key);
    return value;
  });
  mockFetch = jest.fn();
  global.fetch = mockFetch;
  info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
  info.mockRestore();
  jest.useRealTimers();
});

describe('Watchwood signup session', () => {
  it.each(['false', '', undefined])('is default off with enabled value %s', async value => {
    if (value === undefined) delete process.env.WATCHWOOD_SHADOW_ENABLED;
    else process.env.WATCHWOOD_SHADOW_ENABLED = value;
    expect(await (await prepareWatchwoodSignupSession(request())).json()).toEqual({
      enabled: false,
    });
    expect(await readWatchwoodSignupContext()).toEqual({ status: 'missing' });
    expect(await (await assessWatchwoodSignup(request({ token: browserToken }))).json()).toEqual({
      success: true,
    });
    expect(
      await checkWatchwoodSignup({
        operationId: 'operation',
        context: { safetyIdentifier: guid, turnstileGuid: guid },
        email: 'user@example.com',
        ip,
      })
    ).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockGetdel).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it.each(['WATCHWOOD_ORG_ID', 'WATCHWOOD_API_KEY'])('requires %s to enable', async key => {
    delete process.env[key];
    expect(await (await prepareWatchwoodSignupSession(request())).json()).toEqual({
      enabled: false,
    });
  });

  it('generates a signed server identity and reuses it without extending its lifetime', async () => {
    const identity = await session();
    expect(identity).toMatch(/^[a-f0-9-]{36}$/);
    const decoded = jwt.verify(mockCookieValues.get(sessionCookie) ?? '', secret, {
      audience: sessionCookie,
    });
    expect(decoded).toMatchObject({ safetyIdentifier: identity });
    const result = await prepareWatchwoodSignupSession(request());
    expect(await result.json()).toEqual({
      enabled: true,
      org_id: 'test-org',
      safety_identifier: identity,
    });
    expect(result.cookies.get(sessionCookie)).toBeUndefined();
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it('ignores forged or expired session identities', async () => {
    const forgedId = 'dc22a990-f425-479f-b3ab-d48b16d7c02c';
    mockCookieValues.set(
      sessionCookie,
      jwt.sign({ safetyIdentifier: forgedId }, 'different-key', { audience: sessionCookie })
    );
    const result = await prepareWatchwoodSignupSession(request());
    expect((await result.json()).safety_identifier).not.toBe(forgedId);
    const cookie = result.cookies.get(sessionCookie);
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 3600,
    });
    mockCookieValues.set(
      sessionCookie,
      jwt.sign({ safetyIdentifier: forgedId }, secret, { audience: sessionCookie, expiresIn: -1 })
    );
    expect(
      (await (await prepareWatchwoodSignupSession(request())).json()).safety_identifier
    ).not.toBe(forgedId);
  });
});

describe('Watchwood signup context', () => {
  it('returns a verified context and consumes the session cookie', async () => {
    const identity = await session();
    expect(await readWatchwoodSignupContext()).toEqual({
      safetyIdentifier: identity,
      turnstileGuid: guid,
    });
    expect(mockDelete).toHaveBeenCalledWith(sessionCookie);
  });

  it('returns missing without a session cookie', async () => {
    mockCookieValues.set('turnstile_jwt', signed({ guid, ip }));
    expect(await readWatchwoodSignupContext()).toEqual({ status: 'missing' });
  });

  it.each(['forged session', 'missing turnstile', 'forged turnstile'])(
    'returns invalid context for a %s',
    async mode => {
      const identity = await session();
      if (mode === 'forged session')
        mockCookieValues.set(
          sessionCookie,
          jwt.sign({ safetyIdentifier: identity }, 'different-key', { audience: sessionCookie })
        );
      if (mode === 'missing turnstile') mockCookieValues.delete('turnstile_jwt');
      if (mode === 'forged turnstile')
        mockCookieValues.set('turnstile_jwt', jwt.sign({ guid, ip }, 'different-key'));
      expect(await readWatchwoodSignupContext()).toEqual({ status: 'invalid_context' });
    }
  );
});

describe('Watchwood signup token storage', () => {
  it('stores a short-lived single-use token without logging it', async () => {
    const identity = await session();
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(await result.json()).toEqual({ success: true });
    const { key, value, options } = storedRecord();
    expect(key).toMatch(/^watchwood:signup:token:[a-f0-9]{64}$/);
    expect(key).not.toContain(identity);
    expect(value).toEqual({
      token: browserToken,
      ip,
      turnstileGuid: guid,
      receivedAt: expect.any(Number),
      status: 'pending',
    });
    expect(options).toEqual({ ex: 3600 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup token')).toEqual({
      shadow: true,
      enforced: false,
      status: 'pending',
      safetyIdentifier: identity,
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(browserToken);
  });

  it('stores missing token coverage so account creation can report it', async () => {
    const identity = await session();
    await assessWatchwoodSignup(request({ token: '  ', safety_identifier: identity }));
    expect(storedRecord().value).toMatchObject({ token: '', status: 'token_missing' });
    expect(mockEval).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({ status: 'token_missing' });
  });

  it('stores a rate-limited record without calling upstream', async () => {
    const identity = await session();
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
    await assessWatchwoodSignup(request({ token: browserToken, safety_identifier: identity }));
    expect(storedRecord().value).toMatchObject({ token: '', status: 'rate_limited' });
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({ status: 'rate_limited' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not store a submission without a matching signed identity', async () => {
    await session();
    await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: 'dc22a990-f425-479f-b3ab-d48b16d7c02c' })
    );
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({
      status: 'invalid_context',
    });
  });

  it('logs invalid context without storing anything when session cookies are missing', async () => {
    await assessWatchwoodSignup(request({ token: browserToken }));
    expect(mockSet).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup token')).toEqual({
      shadow: true,
      enforced: false,
      status: 'invalid_context',
      safetyIdentifier: undefined,
      latencyMs: expect.any(Number),
    });
  });

  it('fails open when the token store is unavailable', async () => {
    const identity = await session();
    mockSet.mockRejectedValueOnce(new Error('private service detail'));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(await result.json()).toEqual({ success: true });
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private service detail');
    expect(JSON.stringify(info.mock.calls)).not.toContain(browserToken);
  });

  it('bounds the token store within the shared deadline', async () => {
    const identity = await session();
    jest.useFakeTimers();
    const stalled = Promise.withResolvers<'OK'>();
    mockSet.mockReturnValueOnce(stalled.promise);
    const pending = assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(await result.json()).toEqual({ success: true });
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({ status: 'unavailable' });
    stalled.resolve('OK');
    await jest.advanceTimersByTimeAsync(0);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('uses the trusted Vercel address when Turnstile forwarding metadata differs', async () => {
    process.env.VERCEL = '1';
    const identity = await session();
    mockCookieValues.set('turnstile_jwt', signed({ guid, ip }));
    await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-forwarded-for': '192.0.2.11', 'x-vercel-forwarded-for': ip }
      )
    );
    expect(storedRecord().value).toMatchObject({ ip, turnstileGuid: guid });
    mockSet.mockClear();
    await assessWatchwoodSignup(request({ token: browserToken, safety_identifier: identity }));
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a solved Turnstile context replayed from another trusted address', async () => {
    process.env.VERCEL = '1';
    const identity = await session();
    mockCookieValues.set('turnstile_jwt', signed({ guid, ip }));
    await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-forwarded-for': ip, 'x-vercel-forwarded-for': '192.0.2.99' }
      )
    );
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('skips checks without a trusted production address instead of accepting forwarded headers', async () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    const identity = await session();
    await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-vercel-forwarded-for': ip, 'x-real-ip': ip }
      )
    );
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it.each([8193, 20000])('bounds token and request sizes at %i characters', async length => {
    const identity = await session();
    await assessWatchwoodSignup(
      request({ token: 'a'.repeat(length), safety_identifier: identity })
    );
    expect(mockSet).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({
      status: 'invalid_context',
    });
  });

  it('rejects oversized declared bodies before reading them', async () => {
    const identity = await session();
    await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity }, { 'content-length': '20000' })
    );
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('aborts a stalled incoming body rather than waiting indefinitely', async () => {
    await session();
    jest.useFakeTimers();
    const stalled = new NextRequest('https://example.test/api/auth/watchwood', {
      method: 'POST',
      headers: request().headers,
      body: new ReadableStream(),
      duplex: 'half',
    } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>);
    const pending = assessWatchwoodSignup(stalled);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await (await pending).json()).toEqual({ success: true });
    expect(logEntry('[auth] Watchwood signup token')).toMatchObject({ status: 'unavailable' });
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('Watchwood signup check', () => {
  it('checks the account with the received email and records the adopted reasons', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(
      Response.json({
        risk_score: 0.72,
        risk_reasons: [' token_farming ', 'disposable_email'],
        risk_sub_reasons: ['shared_device'],
      })
    );

    const assessment = await check(identity, { email: '  Signup@Example.com ' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(createAccountUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' });
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer synthetic-api-key',
      'Content-Type': 'application/json',
      'X-OpenAI-Watchwood-Token': browserToken,
      'X-OpenAI-Watchwood-Client-IP': ip,
    });
    expect(JSON.parse(init.body)).toEqual({
      safety_identifier: identity,
      extra_signals: { email: 'Signup@Example.com' },
    });
    expect(assessment).toMatchObject({
      status: 'assessed',
      riskScore: 0.72,
      safetyIdentifier: identity,
      riskReasons: ['token_farming', 'disposable_email'],
      riskSubReasons: ['shared_device'],
    });
    expect(logEntry('[auth] Watchwood signup attempt')).toMatchObject({
      operationId: 'operation',
      status: 'assessed',
      riskScore: 0.72,
      tokenAgeMs: expect.any(Number),
      riskReasons: ['token_farming', 'disposable_email'],
      riskSubReasons: ['shared_device'],
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(browserToken);
  });

  it('carries the reasons into the shadow log without the upstream status', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(Response.json({ risk_score: 0.3, risk_reasons: ['speed'] }));
    const assessment = await check(identity);
    if (!assessment) throw new Error('Expected an assessment');
    recordWatchwoodSignupShadow({ operationId: 'operation', provider: 'google', assessment });
    expect(info).toHaveBeenCalledWith(
      '[auth] Watchwood signup shadow',
      expect.objectContaining({ operationId: 'operation', riskReasons: ['speed'] })
    );
  });

  it('flags reasons that are present but do not match the accepted shape', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(
      Response.json({
        risk_score: 0.4,
        risk_reasons: ['a'.repeat(65)],
        risk_sub_reasons: 'token_farming',
      })
    );
    const assessment = await check(identity);
    expect(assessment).toMatchObject({ status: 'assessed', riskScore: 0.4 });
    expect(assessment).not.toHaveProperty('riskReasons');
    expect(assessment).not.toHaveProperty('riskSubReasons');
    expect(logEntry('[auth] Watchwood signup attempt')).toMatchObject({
      riskReasonsUnrecognized: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('a'.repeat(65));
  });

  it('does not flag absent reasons', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(Response.json({ risk_score: 0.4 }));
    await check(identity);
    expect(logEntry('[auth] Watchwood signup attempt')).not.toHaveProperty(
      'riskReasonsUnrecognized'
    );
  });

  it('uses the stored token once and reports the next check as missing', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(Response.json({ risk_score: 0.1 }));
    await check(identity);
    expect(mockGetdel).toHaveBeenCalledTimes(1);
    await expect(check(identity)).resolves.toMatchObject({ status: 'missing' });
    expect(mockGetdel).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports missing when no token record exists', async () => {
    await expect(check(guid)).resolves.toMatchObject({ status: 'missing' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logEntry('[auth] Watchwood signup attempt')).toMatchObject({
      operationId: 'operation',
      status: 'missing',
    });
  });

  it('reports a stored missing-token record without calling upstream', async () => {
    const identity = await session();
    await assessWatchwoodSignup(request({ token: '', safety_identifier: identity }));
    await expect(check(identity)).resolves.toMatchObject({ status: 'token_missing' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports a stored rate-limited record without calling upstream', async () => {
    const identity = await session();
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
    await tokenFor(identity);
    await expect(check(identity)).resolves.toMatchObject({ status: 'rate_limited' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a check from a different trusted address', async () => {
    const identity = await session();
    await tokenFor(identity);
    await expect(check(identity, { ip: '192.0.2.11' })).resolves.toMatchObject({
      status: 'invalid_context',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a check whose Turnstile context changed', async () => {
    const identity = await session();
    await tokenFor(identity);
    await expect(check(identity, { guid: otherGuid })).resolves.toMatchObject({
      status: 'invalid_context',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes a context failure through without touching the token store', async () => {
    await expect(
      checkWatchwoodSignup({
        operationId: 'operation',
        context: { status: 'unavailable' },
        email: 'user@example.com',
        ip,
      })
    ).resolves.toMatchObject({ status: 'unavailable' });
    expect(mockGetdel).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('retries a 5xx once and accepts the subsequent validated score', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch
      .mockResolvedValueOnce(new Response('private upstream details', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ risk_score: 1 }));
    const assessment = await check(identity);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(assessment).toMatchObject({ status: 'assessed', riskScore: 1 });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private upstream details');
  });

  it('records the upstream HTTP status for a 4xx without retrying', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(new Response('sensitive response body', { status: 400 }));
    const assessment = await check(identity);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(assessment).toMatchObject({ status: 'upstream_error', upstreamStatus: 400 });
    expect(logEntry('[auth] Watchwood signup attempt')).toMatchObject({
      status: 'upstream_error',
      upstreamStatus: 400,
    });
    if (!assessment) throw new Error('Expected an assessment');
    recordWatchwoodSignupShadow({ operationId: 'operation', provider: 'google', assessment });
    expect(JSON.stringify(logEntry('[auth] Watchwood signup shadow'))).not.toContain(
      'upstreamStatus'
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('sensitive response body');
  });

  it.each([-0.1, 1.1, '0.2', null, undefined])('rejects an invalid risk score %s', async score => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(Response.json({ risk_score: score }));
    await expect(check(identity)).resolves.toMatchObject({ status: 'invalid_response' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the upstream response size', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ risk_score: 0.2, padding: 'a'.repeat(20000) }))
    );
    await expect(check(identity)).resolves.toMatchObject({ status: 'invalid_response' });
  });

  it('never retries a transport failure or exposes its details', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockFetch.mockRejectedValueOnce(new Error('private transport details'));
    await expect(check(identity)).resolves.toMatchObject({ status: 'unavailable' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain('private transport details');
  });

  it('ignores a stored record that cannot be parsed', async () => {
    const identity = await session();
    await tokenFor(identity);
    mockGetdel.mockResolvedValueOnce('not-json');
    await expect(check(identity)).resolves.toMatchObject({ status: 'missing' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('aborts a stalled upstream within the shared deadline', async () => {
    const identity = await session();
    await tokenFor(identity);
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, options: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      return promise;
    });
    const pending = check(identity);
    await jest.advanceTimersByTimeAsync(1000);
    const assessment = await pending;
    expect(assessment).toMatchObject({ status: 'unavailable', latencyMs: 1000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a creation path without a browser context', async () => {
    await expect(
      checkWatchwoodSignup({
        operationId: 'operation',
        context: undefined,
        email: 'user@example.com',
        ip,
      })
    ).resolves.toBeUndefined();
    expect(mockGetdel).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('does nothing and adds no calls when Watchwood is disabled', async () => {
    delete process.env.WATCHWOOD_SHADOW_ENABLED;
    expect(await check(guid)).toBeUndefined();
    expect(mockGetdel).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('Watchwood signup shadow logging', () => {
  it('logs only advisory fields and does nothing without an assessment', () => {
    recordWatchwoodSignupShadow({
      operationId: 'operation',
      provider: 'test',
      assessment: undefined,
    });
    expect(info).not.toHaveBeenCalled();
    const assessment: WatchwoodSignupAssessment = {
      status: 'assessed',
      riskScore: 0.9,
      riskReasons: ['token_farming'],
      latencyMs: 10,
      assessedAt: 123,
      safetyIdentifier: guid,
    };
    recordWatchwoodSignupShadow({ operationId: 'operation', provider: 'test', assessment });
    expect(info).toHaveBeenCalledWith(
      '[auth] Watchwood signup shadow',
      expect.objectContaining({
        operationId: 'operation',
        provider: 'test',
        riskScore: 0.9,
        riskReasons: ['token_farming'],
        shadow: true,
        enforced: false,
      })
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(browserToken);
  });
});
