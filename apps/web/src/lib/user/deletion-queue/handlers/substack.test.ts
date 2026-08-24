import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  USER_DELETION_DEFAULT_SUBSTACK_PUBLICATION_URL,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@/lib/user/deletion-queue/deletion-constants';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { replaceSubstackCredential } from '@/lib/user/deletion-queue/deletion-substack-credential';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import {
  handleSubstack,
  resolvePublicationBaseUrl,
} from '@/lib/user/deletion-queue/handlers/substack';
import { insertTestUser } from '@/tests/helpers/user.helper';

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

  beforeEach(async () => {
    await cleanupDbForTest();
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
      .mockResolvedValue(new Response('', { status: 200 }));

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
      const { request, step, context } = await setupSubstackRequest();
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    const { request, step, context } = await setupSubstackRequest();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(handleSubstack({ request, step, context })).resolves.toEqual({
      kind: 'not_applicable',
    });
  });

  it('returns manual_action_required when the cookie is expired', async () => {
    const { request, step, context } = await setupSubstackRequest();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));

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
      .mockResolvedValue(new Response('', { status: 200 }));

    await handleSubstack({ request, step, context });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
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
});

async function setupSubstackRequest() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `substack-${crypto.randomUUID()}@example.com`,
  });
  await replaceSubstackCredential({
    material: 'substack.sid=test-cookie',
    actorKiloUserId: admin.id,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, result.requestId));
  if (!request) throw new Error('missing request');

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.Substack,
    claimToken: crypto.randomUUID(),
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };

  await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: context.claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, request.id),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Substack)
      )
    );

  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, request.id),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Substack)
      )
    );
  if (!step) throw new Error('missing step');

  return { request, step, context, email: request.target_email ?? user.google_user_email };
}
