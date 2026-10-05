import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL,
  USER_DELETION_SUBSTACK_PAGE_SIZE,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@/lib/user/deletion-queue/deletion-constants';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import {
  handleSubstack,
  resolvePublicationBaseUrl,
} from '@/lib/user/deletion-queue/handlers/substack';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const mockCredentials = jest.fn();
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockCredentials(),
        }),
      }),
    }),
  },
}));
jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: (name: string) => process.env[name] ?? '',
}));
jest.mock('@/lib/user/deletion-queue/deletion-crypto', () => ({
  decryptDeletionCredential: () => 'substack.sid=test-cookie',
  DeletionCryptoError: class extends Error {},
}));
jest.mock('@/lib/user/deletion-queue/deletion-substack-credential', () => ({
  parseSubstackCredential: jest.fn(),
  persistRefreshedSubstackCookie: jest.fn(),
}));
jest.mock('@/lib/user/deletion-queue/deletion-hmac', () => ({
  hmacResourceRef: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const captureExceptionMock = jest.mocked(captureException);

const credentialMock = jest.requireMock(
  '@/lib/user/deletion-queue/deletion-substack-credential'
) as {
  parseSubstackCredential: jest.Mock;
  persistRefreshedSubstackCookie: jest.Mock;
};

describe('resolvePublicationBaseUrl', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: originalNodeEnv, configurable: true });
  });

  it('defaults empty input to blog.kilo.ai', () => {
    expect(resolvePublicationBaseUrl('   ')).toBe(USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL);
  });

  it('treats slugs as substack.com subdomains', () => {
    expect(resolvePublicationBaseUrl('kilocode')).toBe('https://kilocode.substack.com');
  });

  it('rejects hosts that are not blog.kilo.ai or substack.com', () => {
    expect(() => resolvePublicationBaseUrl('https://evil.example')).toThrow(
      'blog.kilo.ai or a substack.com host'
    );
  });

  it('allows loopback only outside production', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'test', configurable: true });
    expect(resolvePublicationBaseUrl('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true });
    expect(() => resolvePublicationBaseUrl('http://127.0.0.1:4010')).toThrow();
  });
});

describe('handleSubstack', () => {
  const originalPublication = process.env.SUBSTACK_PUBLICATION_URL;

  beforeEach(() => {
    process.env.SUBSTACK_PUBLICATION_URL = 'https://blog.kilo.ai';
    captureExceptionMock.mockClear();
    mockCredentials.mockReset();
    mockCredentials.mockResolvedValue([{ encrypted_material: 'test-material' }]);
    credentialMock.parseSubstackCredential.mockReset();
    credentialMock.parseSubstackCredential.mockImplementation((material: string) => ({
      ok: true,
      credential: { cookie: material, totpSecret: null },
    }));
    credentialMock.persistRefreshedSubstackCookie.mockReset();
    credentialMock.persistRefreshedSubstackCookie.mockResolvedValue({ persisted: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPublication === undefined) delete process.env.SUBSTACK_PUBLICATION_URL;
    else process.env.SUBSTACK_PUBLICATION_URL = originalPublication;
  });

  function withTotpSecret() {
    credentialMock.parseSubstackCredential.mockImplementation(() => ({
      ok: true,
      credential: { cookie: 'substack.sid=test-cookie', totpSecret: RFC_SECRET },
    }));
  }

  it('DELETEs by email with disable_email=true and a browser User-Agent', async () => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber-stats`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          filters: { search: email, order_by_desc_nulls_last: 'subscription_created_at' },
          limit: 50,
          offset: 0,
          includeTags: true,
        }),
      })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber/${encodeURIComponent(email)}?disable_email=true`,
      expect.objectContaining({
        method: 'DELETE',
        redirect: 'error',
        headers: expect.objectContaining({
          'User-Agent': USER_DELETION_SUBSTACK_USER_AGENT,
          Accept: 'application/json',
        }),
      })
    );
    expect(credentialMock.persistRefreshedSubstackCookie).not.toHaveBeenCalled();
  });

  it.each(['User not found', 'Subscription not found'])(
    'treats 400 %s as not_applicable when nothing was deleted this run',
    async error => {
      const { request, step, context, email } = await setupSubstackRequest();
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(subscriberPage([email]))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      await expect(handleSubstack({ request, step, context })).resolves.toEqual({
        kind: 'not_applicable',
      });
    }
  );

  it('treats 404 as not_applicable when nothing was deleted this run', async () => {
    const { request, step, context, email } = await setupSubstackRequest();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
  });

  it.each([
    [401, 'credential_expired'],
    [403, 'substack_forbidden'],
  ])('returns manual_action_required when lookup returns %s', async (status, errorCode) => {
    const { request, step, context } = await setupSubstackRequest();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode,
    });
  });

  it('does not treat a login redirect as success', async () => {
    const { request, step, context } = await setupSubstackRequest();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch: redirect'));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'substack_redirect_blocked',
    });
  });

  it('defaults the publication when SUBSTACK_PUBLICATION_URL is unset', async () => {
    delete process.env.SUBSTACK_PUBLICATION_URL;
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await handleSubstack({ request, step, context });

    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber/${encodeURIComponent(email)}?disable_email=true`
    );
  });

  it('returns needs_attention for an invalid publication host', async () => {
    process.env.SUBSTACK_PUBLICATION_URL = 'https://evil.example';
    const { request, step, context } = await setupSubstackRequest();

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'substack_publication_invalid',
    });
  });

  it('skips an absent email without DELETE or reauth, ignoring partial-email decoys', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([`prefix-${email}`, `${email}.other`]));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber-stats`,
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    );
    expect(credentialMock.persistRefreshedSubstackCookie).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'credential_expired'],
    [403, 'substack_forbidden'],
  ])('keeps a present subscriber blocked when DELETE returns %s', async (status, errorCode) => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([` ${email.toUpperCase()} `]))
      .mockResolvedValueOnce(new Response('unauthorized', { status }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it.each([
    {},
    { subscribers: null },
    { subscribers: [{}] },
    { subscribers: [{ user_email_address: '' }], count: 1 },
    { subscribers: [{ email: 'other@example.com' }], count: 1 },
    { subscribers: [], count: -1 },
    { subscribers: [], count: 0.5 },
    { subscribers: [], count: '0' },
    { subscribers: [], count: 1 },
    { subscribers: [{ user_email_address: 'other@example.com' }], count: 0 },
    { subscribers: [{ user_email_address: 'other@example.com' }], count: 51 },
    { subscribers: [], has_more: true },
    { subscribers: [], pagination: { has_next_page: true } },
    { data: [] },
    [],
  ])('blocks malformed or ambiguous lookup %j without DELETE', async payload => {
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(payload));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks invalid JSON without DELETE', async () => {
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>login</html>'));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 429, 500])('does not skip a failed lookup with HTTP %s', async status => {
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ subscribers: [] }, { status }));
    const result = await handleSubstack({ request, step, context });
    expect(['needs_attention', 'rate_limited', 'retry']).toContain(result.kind);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('searches the next page before deleting an exact match', async () => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        subscriberPage(
          Array.from({ length: USER_DELETION_SUBSTACK_PAGE_SIZE }, (_, i) => `decoy-${i}-${email}`),
          51
        )
      )
      .mockResolvedValueOnce(subscriberPage([email], 51))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).offset).toBe(50);
    expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it.each([false, true])(
    'reschedules a low-time scan with match=%s and retries safely',
    async found => {
      const { request, step, context, email } = await setupSubstackRequest();
      step.progress_json = { processed_count: 2 };
      const firstPage = [
        found ? email : `decoy-${email}`,
        ...Array.from({ length: 49 }, (_, i) => `other-${i}@example.com`),
      ];
      let remainingMs = 60_000;
      context.remainingMs = () => remainingMs;
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
        remainingMs = 0;
        return subscriberPage(firstPage, 51);
      });

      await expect(handleSubstack({ request, step, context })).resolves.toEqual({
        kind: 'continue',
        progress: step.progress_json,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');

      remainingMs = 60_000;
      fetchSpy
        .mockResolvedValueOnce(subscriberPage(firstPage, 51))
        .mockResolvedValueOnce(subscriberPage([found ? 'last@example.com' : email], 51))
        .mockResolvedValueOnce(new Response('', { status: 200 }));
      await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
        kind: 'succeeded',
        progress: { processed_count: 3 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)).offset).toBe(0);
      expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body)).offset).toBe(50);
      expect(fetchSpy.mock.calls[3]?.[1]?.method).toBe('DELETE');
    }
  );

  it('confirms absence at count without an extra empty page', async () => {
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        subscriberPage(
          Array.from(
            { length: USER_DELETION_SUBSTACK_PAGE_SIZE },
            (_, i) => `other-${i}@example.com`
          )
        )
      );
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks repeated pages rather than confirming absence', async () => {
    const { request, step, context } = await setupSubstackRequest();
    const emails = Array.from(
      { length: USER_DELETION_SUBSTACK_PAGE_SIZE },
      (_, i) => `other-${i}@example.com`
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => subscriberPage(emails, 100));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('skips count zero with actual metadata and no tagAssignments', async () => {
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(subscriberPage([]));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks missing credentials without lookup or DELETE', async () => {
    const { request, step, context } = await setupSubstackRequest();
    mockCredentials.mockResolvedValueOnce([]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'credential_missing',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks malformed stored TOTP before any fetch', async () => {
    credentialMock.parseSubstackCredential.mockReturnValueOnce({
      ok: false,
      reason: 'invalid_totp',
    });
    const { request, step, context } = await setupSubstackRequest();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_totp_invalid',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([0, 50, 52])('blocks a changing count of %s even after finding a match', async count => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        subscriberPage(
          [email, ...Array.from({ length: 49 }, (_, i) => `decoy-${i}@example.com`)],
          51
        )
      )
      .mockResolvedValueOnce(subscriberPage(['other@example.com'], count));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks absence when the scan reaches its page cap', async () => {
    const { request, step, context } = await setupSubstackRequest();
    let page = 0;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const offset = page++ * USER_DELETION_SUBSTACK_PAGE_SIZE;
      return subscriberPage(
        Array.from(
          { length: USER_DELETION_SUBSTACK_PAGE_SIZE },
          (_, i) => `other-${offset + i}@example.com`
        ),
        5001
      );
    });
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(100);
  });

  it('reauthenticates with TOTP and carries rotated cookies into DELETE', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith('/subscriber-stats')) return subscriberPage([email]);
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      if (String(url).endsWith('/complete')) return Response.json({});
      return new Response('', { status: 200 });
    });

    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });

    expect(calls.map(call => call.url)).toEqual([
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber-stats`,
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/reauthenticate/start`,
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/reauthenticate/complete`,
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber/${encodeURIComponent(email)}?disable_email=true`,
    ]);
    const completeHeaders = calls[2].init.headers as Record<string, string>;
    expect(completeHeaders.Cookie).toContain('session=rotated');
    const deleteHeaders = calls[3].init.headers as Record<string, string>;
    expect(deleteHeaders.Cookie).toContain('session=rotated');
    expect(credentialMock.persistRefreshedSubstackCookie).toHaveBeenCalledWith({
      originalEncryptedMaterial: 'test-material',
      cookie: 'substack.sid=test-cookie; session=rotated',
      totpSecret: RFC_SECRET,
    });
  });

  it('preserves the DELETE outcome when refreshed cookie persistence fails, reporting a sanitized diagnostic', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/subscriber-stats')) return subscriberPage([email]);
      if (String(url).endsWith('/start')) {
        return Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } });
      }
      if (String(url).endsWith('/complete')) return Response.json({});
      expect(init?.method).toBe('DELETE');
      return new Response('', { status: 200 });
    });
    const dbError = new Error('drizzle failed with params [secret-cookie]');
    credentialMock.persistRefreshedSubstackCookie.mockRejectedValueOnce(dbError);

    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, options] = captureExceptionMock.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('Substack refreshed cookie persistence failed');
    expect((captured as Error).message).not.toContain('secret-cookie');
    expect(captured).not.toBe(dbError);
    expect(options).toEqual({ tags: { source: 'user-deletion-handler', stepKey: 'substack' } });
  });

  it('treats an aborted complete body as a retry without DELETE', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const completeResponse = Response.json({});
    jest
      .spyOn(completeResponse, 'json')
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(
        Response.json({ method: 'totp' }, { headers: { 'set-cookie': 'session=rotated' } })
      )
      .mockResolvedValueOnce(completeResponse);

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'retry',
      errorCode: 'timeout',
      httpStatusClass: 'timeout',
    });
    expect(fetchSpy.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false);
    expect(credentialMock.persistRefreshedSubstackCookie).toHaveBeenCalled();
  });

  it.each([
    [401, 'credential_expired'],
    [403, 'substack_forbidden'],
    [400, 'substack_reauth_rejected'],
    [422, 'substack_reauth_rejected'],
  ])('never DELETEs when completion returns HTTP %s', async (status, errorCode) => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(new Response('', { status }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode,
    });
    expect(fetchSpy.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false);
  });

  it.each([429, 500])('classifies completion HTTP %s as transient', async status => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(Response.json({ method: 'totp' }))
      .mockResolvedValueOnce(new Response('', { status }));

    const result = await handleSubstack({ request, step, context });
    expect(['rate_limited', 'retry']).toContain(result.kind);
    expect(fetchSpy.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false);
  });

  it('blocks an unsupported reauth method without DELETE', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(Response.json({ method: 'email' }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_reauth_method_unsupported',
    });
    expect(fetchSpy.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false);
  });

  it('does not reauthenticate when low time remains after a match', async () => {
    withTotpSecret();
    const { request, step, context, email } = await setupSubstackRequest();
    let remainingMs = 60_000;
    context.remainingMs = () => remainingMs;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      remainingMs = 0;
      return subscriberPage([email]);
    });

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'continue',
      progress: step.progress_json,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(credentialMock.persistRefreshedSubstackCookie).not.toHaveBeenCalled();
  });
});

function subscriberPage(emails: string[], count = emails.length) {
  return Response.json({
    subscribers: emails.map((email, id) => ({
      user_id: id,
      subscription_id: id,
      user_email_address: email,
      is_subscribed: false,
    })),
    count,
    pendingImports: [],
    pendingCRMImportsCount: 0,
    order: { by: 'subscription_created_at', direction: 'desc' },
    chartCounts: {},
    batchSubscriberActions: [],
    lastSync: '2026-10-05T00:00:00Z',
    ...(count > 0 ? { tagAssignments: {} } : {}),
  });
}

async function setupSubstackRequest() {
  const email = `substack-${crypto.randomUUID()}@example.com`;
  const request = { id: crypto.randomUUID(), target_email: email } as UserDeletionRequest;
  const step = { progress_json: {} } as UserDeletionStep;

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.Substack,
    claimToken: crypto.randomUUID(),
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };

  return { request, step, context, email };
}
