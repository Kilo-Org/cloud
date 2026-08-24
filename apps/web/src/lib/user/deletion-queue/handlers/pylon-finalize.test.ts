import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import { UserDeletionStepKey, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { USER_DELETION_PYLON_DELETE_COMPLETE_TAG } from '@/lib/user/deletion-queue/deletion-constants';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handlePylonFinalize } from '@/lib/user/deletion-queue/handlers/pylon-finalize';
import { insertTestUser } from '@/tests/helpers/user.helper';

const ISSUE_ID = 'iss-finalize';
const TARGET_EMAIL = 'user@example.com';

describe('handlePylonFinalize', () => {
  const originalApiKey = process.env.PYLON_API_KEY;

  beforeEach(async () => {
    await cleanupDbForTest();
    process.env.PYLON_API_KEY = 'test-pylon-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiKey === undefined) delete process.env.PYLON_API_KEY;
    else process.env.PYLON_API_KEY = originalApiKey;
  });

  it('is not applicable when the request has no ticket', async () => {
    const { request, step, context } = await setupFinalizeRequest();
    const outcome = await handlePylonFinalize({
      request: { ...request, pylon_ticket_ref: null },
      step,
      context,
    });
    expect(outcome).toEqual({ kind: 'not_applicable' });
  });

  it('adds delete-complete then closes the issue', async () => {
    const { request, step, context } = await setupFinalizeRequest();
    const fetchSpy = mockPylon({ tags: [] });

    const outcome = await handlePylonFinalize({ request, step, context });
    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(tagPatches(fetchSpy)).toEqual([{ tags: [USER_DELETION_PYLON_DELETE_COMPLETE_TAG] }]);
    expect(closePatches(fetchSpy)).toEqual([{ state: 'closed' }]);
    expect(patchOrder(fetchSpy)).toEqual(['tags', 'close']);
  });

  it('retries a tag error and does not close', async () => {
    const { request, step, context } = await setupFinalizeRequest();
    const fetchSpy = mockPylon({ tags: [], tagStatus: 500 });

    const outcome = await handlePylonFinalize({ request, step, context });
    expect(outcome).toEqual({
      kind: 'retry',
      errorCode: 'http_500',
      httpStatusClass: '5xx',
    });
    expect(tagPatches(fetchSpy)).toHaveLength(1);
    expect(closePatches(fetchSpy)).toHaveLength(0);
  });

  it('retries a close 404 after tagging', async () => {
    const { request, step, context } = await setupFinalizeRequest();
    const fetchSpy = mockPylon({ tags: [], closeStatus: 404 });

    const outcome = await handlePylonFinalize({ request, step, context });
    expect(outcome).toEqual({
      kind: 'retry',
      errorCode: 'http_404',
      httpStatusClass: 'error',
    });
    expect(tagPatches(fetchSpy)).toHaveLength(1);
    expect(closePatches(fetchSpy)).toHaveLength(1);
  });

  it('closes an already-tagged issue without tagging again', async () => {
    const { request, step, context } = await setupFinalizeRequest();
    const fetchSpy = mockPylon({ tags: [USER_DELETION_PYLON_DELETE_COMPLETE_TAG] });

    const outcome = await handlePylonFinalize({ request, step, context });
    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(tagPatches(fetchSpy)).toHaveLength(0);
    expect(closePatches(fetchSpy)).toEqual([{ state: 'closed' }]);
  });
});

async function setupFinalizeRequest() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({ google_user_email: TARGET_EMAIL });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [
      {
        email: TARGET_EMAIL,
        pylonTicket: `#${ISSUE_ID}`,
        ...(user ? { trustedUserId: user.id } : {}),
      },
    ],
  });
  expect(result.status).toBe('enqueued');
  if (result.status !== 'enqueued') throw new Error('expected enqueued');

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, result.requestId));
  if (!request) throw new Error('missing request');

  const claimToken = crypto.randomUUID();
  let [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, request.id),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonFinalize)
      )
    );
  if (!step) {
    const [inserted] = await db
      .insert(user_deletion_steps)
      .values({
        request_id: request.id,
        step_key: UserDeletionStepKey.PylonFinalize,
      })
      .returning();
    step = inserted;
  }
  if (!step) throw new Error('missing step');

  const [claimed] = await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
      progress_json: {},
    })
    .where(eq(user_deletion_steps.id, step.id))
    .returning();
  if (!claimed) throw new Error('missing claimed step');

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.PylonFinalize,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
  return { request, step: claimed, context };
}

function mockPylon(params: { tags: string[]; tagStatus?: number; closeStatus?: number }) {
  let currentTags = [...params.tags];
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (!url.endsWith(`/issues/${ISSUE_ID}`)) {
      throw new Error(`unexpected fetch ${method} ${url}`);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        tags?: string[];
        state?: string;
      };
      if (body.tags) {
        if (params.tagStatus && params.tagStatus !== 200) {
          return new Response('tag failed', { status: params.tagStatus });
        }
        currentTags = body.tags;
        return jsonResponse({ data: { id: ISSUE_ID, tags: currentTags, state: 'open' } });
      }
      if (params.closeStatus && params.closeStatus !== 200) {
        return new Response('not found', { status: params.closeStatus });
      }
      return jsonResponse({ data: { id: ISSUE_ID, tags: currentTags, state: 'closed' } });
    }
    return jsonResponse({
      data: { id: ISSUE_ID, tags: currentTags, state: 'open' },
    });
  });
}

function patchBodies(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(
      ([, init]) => JSON.parse(String(init?.body ?? '{}')) as { tags?: string[]; state?: string }
    );
}

function tagPatches(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return patchBodies(fetchSpy).filter(body => Array.isArray(body.tags));
}

function closePatches(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return patchBodies(fetchSpy).filter(body => body.state === 'closed');
}

function patchOrder(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return patchBodies(fetchSpy).map(body => (Array.isArray(body.tags) ? 'tags' : 'close'));
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
