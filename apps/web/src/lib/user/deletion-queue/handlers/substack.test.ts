import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
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

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ encrypted_material: 'test-material' }],
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
  cookieFromCredential: (material: string) => material,
}));
jest.mock('@/lib/user/deletion-queue/deletion-hmac', () => ({
  hmacResourceRef: jest.fn(),
}));

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPublication === undefined) delete process.env.SUBSTACK_PUBLICATION_URL;
    else process.env.SUBSTACK_PUBLICATION_URL = originalPublication;
  });

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

  it.each([401, 403])('returns manual_action_required when lookup returns %s', async status => {
    const { request, step, context } = await setupSubstackRequest();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'credential_expired',
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

  it('skips an absent email without DELETE, ignoring partial-email decoys', async () => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([`prefix-${email}`, `${email}.other`]));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber?offset=0&limit=50`,
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
  });

  it.each([401, 403])('keeps a present subscriber blocked when DELETE returns %s', async status => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(subscriberPage([` ${email.toUpperCase()} `]))
      .mockResolvedValueOnce(new Response('unauthorized', { status }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'credential_expired',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it.each([
    {},
    { subscribers: null },
    { subscribers: [{}] },
    { subscribers: [{ id: 1, email: '' }] },
    { subscribers: [{ email: 'other@example.com' }] },
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
          Array.from({ length: USER_DELETION_SUBSTACK_PAGE_SIZE }, (_, i) => `decoy-${i}-${email}`)
        )
      )
      .mockResolvedValueOnce(subscriberPage([email]))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      `${USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL}/api/v1/subscriber?offset=50&limit=50`
    );
    expect(fetchSpy.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('requires a terminal page before confirming absence', async () => {
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
      )
      .mockResolvedValueOnce(subscriberPage([]));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks repeated pages rather than confirming absence', async () => {
    const { request, step, context } = await setupSubstackRequest();
    const emails = Array.from(
      { length: USER_DELETION_SUBSTACK_PAGE_SIZE },
      (_, i) => `other-${i}@example.com`
    );
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => subscriberPage(emails));
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('allows envelope metadata when an exact match proves presence', async () => {
    const { request, step, context, email } = await setupSubstackRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ subscribers: [{ id: 1, email }], total: 5000 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(handleSubstack({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe('DELETE');
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
        )
      );
    });
    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'substack_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(100);
  });
});

function subscriberPage(emails: string[]) {
  return Response.json({ subscribers: emails.map((email, id) => ({ id, email })) });
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
