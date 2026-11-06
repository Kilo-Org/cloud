import jwt from 'jsonwebtoken';
import { NextRequest, type NextResponse } from 'next/server';
import {
  assessWatchwoodSignup,
  prepareWatchwoodSignupSession,
  readWatchwoodSignupAssessment,
  type WatchwoodSignupAssessment,
  recordWatchwoodSignupShadow,
} from './watchwood';

const mockCookieValues = new Map<string, string>();
const mockDelete = jest.fn((name: string) => mockCookieValues.delete(name));
const mockEval = jest.fn();
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
  },
}));

const secret = 'watchwood-unit-test-signing-key';
const sessionCookie = 'watchwood_signup_session';
const assessmentCookie = 'watchwood_signup_assessment';
const guid = '4829b420-d43c-4f31-893d-f5042cf274cf';
const ip = '192.0.2.10';
const browserToken = 'synthetic-watchwood-token';
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
  mockCookieValues.set('turnstile_jwt', signed({ guid, ip, watchwoodIp: ip }));
  return data.safety_identifier as string;
}

function assessment(result: NextResponse) {
  const value = result.cookies.get(assessmentCookie)?.value;
  expect(value).toBeDefined();
  mockCookieValues.set(assessmentCookie, value ?? '');
  const decoded = jwt.verify(value ?? '', secret, {
    algorithms: ['HS256'],
    audience: assessmentCookie,
  });
  expect(typeof decoded).toBe('object');
  if (typeof decoded === 'string') throw new Error('Expected signed assessment');
  return decoded.assessment;
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
  jest.clearAllMocks();
  mockEval.mockResolvedValue(1);
  mockFetch = jest.fn().mockResolvedValue(Response.json({ risk_score: 0.4 }));
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
    expect(await readWatchwoodSignupAssessment()).toBeUndefined();
    expect(await (await assessWatchwoodSignup(request({ token: browserToken }))).json()).toEqual({
      success: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
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

describe('Watchwood signup assessment', () => {
  it('stores a signed advisory result without persisting sensitive inputs', async () => {
    const identity = await session();
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(await result.json()).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(assessment(result)).toMatchObject({
      status: 'assessed',
      riskScore: 0.4,
      safetyIdentifier: identity,
      latencyMs: expect.any(Number),
      assessedAt: expect.any(Number),
    });
    expect(result.cookies.get(assessmentCookie)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 3600,
    });
    expect(await readWatchwoodSignupAssessment()).toMatchObject({
      status: 'assessed',
      riskScore: 0.4,
    });
    expect(mockDelete).toHaveBeenCalledWith(assessmentCookie);
    expect(mockDelete).toHaveBeenCalledWith(sessionCookie);
    const safeOutput = JSON.stringify({
      logs: info.mock.calls,
      cookie: jwt.decode(result.cookies.get(assessmentCookie)?.value ?? ''),
    });
    for (const sensitive of [browserToken, 'synthetic-api-key', ip])
      expect(safeOutput).not.toContain(sensitive);
    expect(info).toHaveBeenCalledWith(
      '[auth] Watchwood signup attempt',
      expect.objectContaining({ shadow: true, enforced: false, safetyIdentifier: identity })
    );
  });

  it('does not accept an unsigned browser identity or a different signed session', async () => {
    await session();
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: 'dc22a990-f425-479f-b3ab-d48b16d7c02c' })
    );
    expect(assessment(result).status).toBe('invalid_context');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['missing', 'forged', 'expired', 'ip_mismatch', 'legacy'])(
    'requires a valid matching Turnstile context: %s',
    async mode => {
      const identity = await session();
      if (mode === 'missing') mockCookieValues.delete('turnstile_jwt');
      if (mode === 'legacy') mockCookieValues.set('turnstile_jwt', signed({ guid, ip }));
      if (mode === 'forged')
        mockCookieValues.set('turnstile_jwt', jwt.sign({ guid, ip, watchwoodIp: ip }, 'wrong-key'));
      if (mode === 'expired')
        mockCookieValues.set(
          'turnstile_jwt',
          jwt.sign({ guid, ip, watchwoodIp: ip }, secret, { expiresIn: -1 })
        );
      if (mode === 'ip_mismatch')
        mockCookieValues.set('turnstile_jwt', signed({ guid, ip, watchwoodIp: '192.0.2.11' }));
      const result = await assessWatchwoodSignup(
        request({ token: browserToken, safety_identifier: identity })
      );
      expect(await result.json()).toEqual({ success: true });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.cookies.get(assessmentCookie)).toBeUndefined();
    }
  );

  it('uses the trusted Vercel address when Turnstile forwarding metadata differs', async () => {
    process.env.VERCEL = '1';
    const identity = await session();
    mockCookieValues.set('turnstile_jwt', signed({ guid, ip: '192.0.2.11', watchwoodIp: ip }));
    await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-forwarded-for': '192.0.2.11', 'x-vercel-forwarded-for': ip }
      )
    );
    expect(mockFetch.mock.calls[0][1].headers['X-OpenAI-Watchwood-Client-IP']).toBe(ip);
    mockFetch.mockClear();
    await assessWatchwoodSignup(request({ token: browserToken, safety_identifier: identity }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a solved Turnstile context replayed from another trusted address', async () => {
    process.env.VERCEL = '1';
    const identity = await session();
    mockCookieValues.set('turnstile_jwt', signed({ guid, ip, watchwoodIp: ip }));

    const result = await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-forwarded-for': ip, 'x-vercel-forwarded-for': '192.0.2.99' }
      )
    );

    expect(await result.json()).toEqual({ success: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
    expect(result.cookies.get(assessmentCookie)).toBeUndefined();
  });

  it('skips checks without a trusted production address instead of accepting forwarded headers', async () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    const identity = await session();
    const result = await assessWatchwoodSignup(
      request(
        { token: browserToken, safety_identifier: identity },
        { 'x-vercel-forwarded-for': ip, 'x-real-ip': ip }
      )
    );
    expect(await result.json()).toEqual({ success: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('records missing coverage without calling upstream or charging the budget', async () => {
    const identity = await session();
    const result = await assessWatchwoodSignup(request({ token: '', safety_identifier: identity }));
    expect(assessment(result).status).toBe('token_missing');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it.each([8193, 20000])('bounds token and request sizes at %i characters', async length => {
    const identity = await session();
    const result = await assessWatchwoodSignup(
      request({ token: 'a'.repeat(length), safety_identifier: identity })
    );
    expect(assessment(result).status).toBe('invalid_context');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects oversized declared bodies before reading them', async () => {
    const identity = await session();
    await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity }, { 'content-length': '20000' })
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not send repeated checks once either the Turnstile or address budget is exhausted', async () => {
    const identity = await session();
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(assessment(result).status).toBe('rate_limited');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval.mock.calls[0][1][0]).not.toContain(guid);
    expect(mockEval.mock.calls[1][1][0]).not.toContain(ip);
    mockEval.mockResolvedValueOnce(4);
    const second = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(assessment(second).status).toBe('rate_limited');
  });

  it('skips paid checks when Redis fails without failing authentication', async () => {
    const identity = await session();
    mockEval.mockRejectedValueOnce(new Error('private service detail'));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(await result.json()).toEqual({ success: true });
    expect(assessment(result).status).toBe('unavailable');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('private service detail');
  });

  it('finishes within the total deadline when the atomic Redis budget never settles', async () => {
    const identity = await session();
    jest.useFakeTimers();
    const stalled = Promise.withResolvers<number>();
    mockEval.mockReturnValueOnce(stalled.promise);
    const pending = assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(await result.json()).toEqual({ success: true });
    expect(assessment(result)).toMatchObject({ status: 'unavailable', latencyMs: 1000 });
    const originalCookie = result.cookies.get(assessmentCookie)?.value;
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    stalled.resolve(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(result.cookies.get(assessmentCookie)?.value).toBe(originalCookie);
  });

  it('retries a 5xx once and accepts the subsequent validated score', async () => {
    const identity = await session();
    mockFetch
      .mockResolvedValueOnce(new Response('private upstream details', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ risk_score: 1 }));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(assessment(result)).toMatchObject({ status: 'assessed', riskScore: 1 });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private upstream details');
  });

  it.each([400, 401, 429, 302, 503])(
    'never retries non-5xx or retries 5xx more than once: %i',
    async status => {
      const identity = await session();
      mockFetch.mockImplementation(async () => new Response('sensitive response body', { status }));
      const result = await assessWatchwoodSignup(
        request({ token: browserToken, safety_identifier: identity })
      );
      expect(mockFetch).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
      expect(assessment(result).status).toBe('upstream_error');
      expect(JSON.stringify(info.mock.calls)).not.toContain('sensitive response body');
    }
  );

  it.each([-0.1, 1.1, '0.2', null, undefined])('rejects an invalid risk score %s', async score => {
    const identity = await session();
    mockFetch.mockResolvedValueOnce(Response.json({ risk_score: score }));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(assessment(result).status).toBe('invalid_response');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds upstream response size', async () => {
    const identity = await session();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ risk_score: 0.2, padding: 'a'.repeat(20000) }))
    );
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(assessment(result).status).toBe('invalid_response');
  });

  it('aborts a stalled upstream within the shared deadline and never retries it', async () => {
    const identity = await session();
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, options: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      return promise;
    });
    const pending = assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(assessment(result)).toMatchObject({ status: 'unavailable', latencyMs: 1000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a transport failure or expose its details', async () => {
    const identity = await session();
    mockFetch.mockRejectedValueOnce(new Error('private transport details'));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(await result.json()).toEqual({ success: true });
    expect(assessment(result).status).toBe('unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain('private transport details');
  });

  it('rejects a non-finite JSON number', async () => {
    const identity = await session();
    mockFetch.mockResolvedValueOnce(new Response('{"risk_score":1e999}'));
    const result = await assessWatchwoodSignup(
      request({ token: browserToken, safety_identifier: identity })
    );
    expect(assessment(result).status).toBe('invalid_response');
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
    expect(assessment(await pending).status).toBe('unavailable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('Watchwood signup attribution', () => {
  it('returns missing coverage rather than throwing when there is no assessment', async () => {
    expect(await readWatchwoodSignupAssessment()).toMatchObject({ status: 'missing' });
  });

  it.each(['signature', 'session', 'turnstile'])(
    'does not attribute a stale or forged assessment: %s',
    async mode => {
      const identity = await session();
      assessment(
        await assessWatchwoodSignup(request({ token: browserToken, safety_identifier: identity }))
      );
      if (mode === 'signature')
        mockCookieValues.set(assessmentCookie, `${mockCookieValues.get(assessmentCookie)}x`);
      if (mode === 'session')
        mockCookieValues.set(
          sessionCookie,
          signed({ safetyIdentifier: 'dc22a990-f425-479f-b3ab-d48b16d7c02c' }, sessionCookie)
        );
      if (mode === 'turnstile')
        mockCookieValues.set(
          'turnstile_jwt',
          signed({ guid: 'dc22a990-f425-479f-b3ab-d48b16d7c02c', ip, watchwoodIp: ip })
        );
      expect(await readWatchwoodSignupAssessment()).toMatchObject({ status: 'invalid_context' });
    }
  );

  it('logs only advisory fields and does nothing when disabled', () => {
    recordWatchwoodSignupShadow({
      operationId: 'operation',
      provider: 'test',
      assessment: undefined,
    });
    expect(info).not.toHaveBeenCalled();
    recordWatchwoodSignupShadow({
      operationId: 'operation',
      provider: 'test',
      assessment: {
        status: 'assessed',
        riskScore: 0.9,
        latencyMs: 10,
        assessedAt: 123,
        token: browserToken,
      } as WatchwoodSignupAssessment,
    });
    expect(info).toHaveBeenCalledWith(
      '[auth] Watchwood signup shadow',
      expect.objectContaining({
        operationId: 'operation',
        provider: 'test',
        riskScore: 0.9,
        shadow: true,
        enforced: false,
      })
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(browserToken);
  });
});
