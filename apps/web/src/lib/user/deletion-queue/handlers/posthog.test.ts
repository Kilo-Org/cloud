import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { encryptDeletionResourceIds } from '@/lib/user/deletion-queue/deletion-crypto';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handlePosthog } from '@/lib/user/deletion-queue/handlers/posthog';
import { insertTestUser } from '@/tests/helpers/user.helper';

const PERSON_A = 'person-a';
const PERSON_B = 'person-b';

describe('handlePosthog verify', () => {
  const originalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const originalProjectId = process.env.POSTHOG_ENVIRONMENT_ID;

  beforeEach(async () => {
    await cleanupDbForTest();
    process.env.POSTHOG_PERSONAL_API_KEY = 'test-posthog-key';
    process.env.POSTHOG_ENVIRONMENT_ID = 'proj-test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiKey === undefined) delete process.env.POSTHOG_PERSONAL_API_KEY;
    else process.env.POSTHOG_PERSONAL_API_KEY = originalApiKey;
    if (originalProjectId === undefined) delete process.env.POSTHOG_ENVIRONMENT_ID;
    else process.env.POSTHOG_ENVIRONMENT_ID = originalProjectId;
  });

  it('does not succeed when the first person is gone but another remains', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/persons/${PERSON_A}`)) return new Response(null, { status: 404 });
      if (url.endsWith(`/persons/${PERSON_B}`)) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).not.toBe('succeeded');
    expect(outcome.kind === 'continue' || outcome.kind === 'needs_attention').toBe(true);
    if (outcome.kind === 'needs_attention') {
      expect(outcome.errorCode).toBe('posthog_verify_timeout');
    }

    const progress = await loadProgress(request.id);
    expect(progress?.provider_ref).toBe('submitted');
  });

  it('succeeds a reserved checkpoint when the email lookup is empty and checkpointed persons are gone', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B], {
      providerRef: 'reserved',
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/persons/?email=')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (url.endsWith(`/persons/${PERSON_A}`) || url.endsWith(`/persons/${PERSON_B}`)) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).toBe('succeeded');

    const progress = await loadProgress(request.id);
    expect(progress?.provider_ref).toBe('reserved');
  });

  it('does not treat a reserved effect as not_applicable when the email lookup is empty', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A], {
      providerRef: 'reserved',
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/persons/?email=')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (url.endsWith(`/persons/${PERSON_A}`)) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).not.toBe('not_applicable');
    expect(outcome.kind).not.toBe('succeeded');

    const progress = await loadProgress(request.id);
    expect(progress?.provider_ref).toBe('reserved');
  });

  it('succeeds when every checkpointed person is gone', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const progress = await loadProgress(request.id);
    expect(progress?.provider_ref).toBe('submitted');
  });
});

async function setupSubmittedEffect(personIds: string[], options: { providerRef?: string } = {}) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `posthog-${crypto.randomUUID()}@example.com`,
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

  let [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, request.id),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );
  if (!step) {
    const [inserted] = await db
      .insert(user_deletion_steps)
      .values({
        request_id: request.id,
        step_key: UserDeletionStepKey.Posthog,
      })
      .returning();
    step = inserted;
  }
  if (!step) throw new Error('missing step');

  await db
    .update(user_deletion_steps)
    .set({
      progress_json: {
        provider_ref: options.providerRef ?? 'submitted',
        encrypted_resource_ids: encryptDeletionResourceIds(personIds),
        checkpoint_at: new Date().toISOString(),
      },
    })
    .where(eq(user_deletion_steps.id, step.id));

  const [reloaded] = await db
    .select()
    .from(user_deletion_steps)
    .where(eq(user_deletion_steps.id, step.id));
  if (!reloaded) throw new Error('missing reloaded step');
  step = reloaded;

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.Posthog,
    claimToken: crypto.randomUUID(),
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
  return { request, step, context };
}

async function loadProgress(requestId: string) {
  const [row] = await db
    .select({ progress_json: user_deletion_steps.progress_json })
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );
  return row?.progress_json;
}
