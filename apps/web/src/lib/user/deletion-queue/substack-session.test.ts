import {
  applyResponseCookies,
  parseCookieHeader,
  reauthenticateSubstackSession,
  serializeCookieJar,
} from '@/lib/user/deletion-queue/substack-session';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const PUBLICATION = 'https://blog.kilo.ai';

function responseWithCookies(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const setCookie of setCookies) headers.append('set-cookie', setCookie);
  return new Response('', { status: 200, headers });
}

describe('cookie jar', () => {
  it('parses and serializes multiple cookies', () => {
    expect(serializeCookieJar(parseCookieHeader('connect.sid=abc; theme=dark'))).toBe(
      'connect.sid=abc; theme=dark'
    );
  });

  it('applies multiple Set-Cookie headers', () => {
    const response = responseWithCookies('a=1', 'b=2');
    expect(applyResponseCookies('connect.sid=x', response)).toBe('connect.sid=x; a=1; b=2');
  });

  it('removes cookies on Max-Age=0 and on an expired Expires', () => {
    const response = responseWithCookies(
      'a=; Max-Age=0',
      'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
    expect(applyResponseCookies('a=1; b=2; connect.sid=x', response)).toBe('connect.sid=x');
  });

  it('keeps a cookie with a future Expires', () => {
    const response = responseWithCookies('a=9; Expires=Fri, 01 Jan 2100 00:00:00 GMT');
    expect(applyResponseCookies('a=1', response)).toBe('a=9');
  });

  it('returns the original string when nothing changes', () => {
    const response = responseWithCookies('a=1');
    expect(applyResponseCookies('a=1; connect.sid=x', response)).toBe('a=1; connect.sid=x');
  });
});

describe('reauthenticateSubstackSession', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends start then complete, carrying rotated cookies forward', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      return Response.json({});
    });

    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      now: () => 59_000,
    });

    expect(result).toMatchObject({ ok: true, method: 'totp', cookieChanged: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${PUBLICATION}/api/v1/reauthenticate/start`);
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[1].url).toBe(`${PUBLICATION}/api/v1/reauthenticate/complete`);
    const completeHeaders = calls[1].init.headers as Record<string, string>;
    expect(completeHeaders.Cookie).toContain('session=rotated');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ code: '287082' });
  });

  it('does not make a request when the guard is already closed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      guard: () => false,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'low_time' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops before complete when the guard closes after start', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } })
      );
    const guard = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
      guard,
    });

    expect(result).toMatchObject({ ok: false, failure: { kind: 'low_time' } });
    expect(result.ok === false && result.cookie).toContain('session=rotated');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported method without completing', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ method: 'email' }));
    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'method_unsupported' } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500])('reports completion HTTP %s', async status => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(new Response('', { status }));
    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'http', status } });
  });

  it('does not count malformed completion JSON as success', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }));
    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'incomplete' } });
  });

  it('does not count an error payload as success', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(Response.json({ error: 'Invalid code' }));
    const result = await reauthenticateSubstackSession({
      publication: PUBLICATION,
      cookie: 'connect.sid=old',
      totpSecret: RFC_SECRET,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'error_payload' } });
  });

  it.each([[{ success: false }], [{ errors: ['Invalid code'] }]])(
    'does not count negative completion payload %j as success',
    async payload => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ method: 'totp' }))
        .mockResolvedValueOnce(Response.json(payload));
      const result = await reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: 'error_payload' } });
    }
  );

  it('accepts unknown additive fields on a successful completion payload', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(Response.json({ trace_id: 'abc', request_duration_ms: 12 }));
    await expect(
      reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      })
    ).resolves.toMatchObject({ ok: true, method: 'totp' });
  });

  it.each(['AbortError', 'TimeoutError'])(
    'classifies an aborted start body (%s) as a fetch timeout',
    async name => {
      const startResponse = Response.json({ method: 'totp' });
      jest
        .spyOn(startResponse, 'json')
        .mockRejectedValue(new DOMException('aborted', name as 'AbortError' | 'TimeoutError'));
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(startResponse);

      const result = await reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      });

      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'fetch_failed', errorCode: 'timeout' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['AbortError', 'TimeoutError'])(
    'classifies an aborted complete body (%s) as a fetch timeout',
    async name => {
      const completeResponse = Response.json({});
      jest
        .spyOn(completeResponse, 'json')
        .mockRejectedValue(new DOMException('aborted', name as 'AbortError' | 'TimeoutError'));
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ method: 'totp' }))
        .mockResolvedValueOnce(completeResponse);

      const result = await reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      });

      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'fetch_failed', errorCode: 'timeout' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['start', 'complete'])(
    'classifies a dropped %s response body as a network failure',
    async phase => {
      const droppedResponse = Response.json(
        {},
        {
          headers: { 'Set-Cookie': 'connect.sid=rotated-before-disconnect; Path=/' },
        }
      );
      jest.spyOn(droppedResponse, 'json').mockRejectedValue(new TypeError('terminated'));
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      if (phase === 'complete') fetchSpy.mockResolvedValueOnce(Response.json({ method: 'totp' }));
      fetchSpy.mockResolvedValueOnce(droppedResponse);

      const result = await reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      });

      expect(result).toMatchObject({
        ok: false,
        cookie: 'connect.sid=rotated-before-disconnect',
        cookieChanged: true,
        failure: { kind: 'fetch_failed', errorCode: 'network_error' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(phase === 'start' ? 1 : 2);
    }
  );

  it.each(['not base32!', 'AB'])(
    'fails closed for a malformed secret (%s) before any request',
    async totpSecret => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ method: 'totp' }));
      const result = await reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret,
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: 'invalid_totp_secret' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('classifies network and redirect fetch failures', async () => {
    const networkSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      })
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'fetch_failed', errorCode: 'network_error' },
    });
    networkSpy.mockRestore();

    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch: redirect'));
    await expect(
      reauthenticateSubstackSession({
        publication: PUBLICATION,
        cookie: 'connect.sid=old',
        totpSecret: RFC_SECRET,
      })
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'fetch_failed', errorCode: 'redirect' },
    });
  });
});
