import { and, eq } from 'drizzle-orm';
import {
  user_deletion_activity,
  user_deletion_requests,
  user_deletion_steps,
} from '@kilocode/db/schema';
import { UserDeletionStepKey, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handlePylonContact } from '@/lib/user/deletion-queue/handlers/pylon-contact';
import { insertTestUser } from '@/tests/helpers/user.helper';

const TARGET_EMAIL = 'user@example.com';
const EXTRA_EMAIL = 'other@example.com';

describe('handlePylonContact', () => {
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

  it('is not applicable when search returns no contacts', async () => {
    const { request, step, context } = await setupContactRequest();
    mockPylon({ contacts: [] });

    const outcome = await handlePylonContact({ request, step, context });
    expect(outcome).toEqual({ kind: 'not_applicable' });
  });

  it('is not applicable when search omits data', async () => {
    const { request, step, context } = await setupContactRequest();
    mockPylon({ searchBody: { request_id: '2cea4887-e3f3-452d-837b-bb3e590939de' } });

    const outcome = await handlePylonContact({ request, step, context });
    expect(outcome).toEqual({ kind: 'not_applicable' });
  });

  it('needs attention when search data is not a contact list', async () => {
    const { request, step, context } = await setupContactRequest();
    mockPylon({ searchBody: { data: { unexpected: true } } });

    const outcome = await handlePylonContact({ request, step, context });
    expect(outcome).toEqual({
      kind: 'needs_attention',
      errorCode: 'pylon_contact_lookup_incomplete',
    });
  });

  it('blocks when an extra email belongs to another Kilo user', async () => {
    await insertTestUser({ google_user_email: EXTRA_EMAIL });
    const { request, step, context } = await setupContactRequest();
    const fetchSpy = mockPylon({
      contacts: [{ id: 'contact-1', email: TARGET_EMAIL, emails: [TARGET_EMAIL, EXTRA_EMAIL] }],
    });

    const outcome = await handlePylonContact({ request, step, context });
    expect(outcome).toEqual({
      kind: 'needs_attention',
      errorCode: 'pylon_contact_shared_identity',
    });
    expect(deletedContacts(fetchSpy)).toHaveLength(0);
  });

  it('deletes when an extra email has no Kilo user', async () => {
    const { request, step, context } = await setupContactRequest();
    const fetchSpy = mockPylon({
      contacts: [{ id: 'contact-1', email: TARGET_EMAIL, emails: [TARGET_EMAIL, EXTRA_EMAIL] }],
    });

    const outcome = await handlePylonContact({ request, step, context });
    expect(outcome).toEqual({
      kind: 'continue',
      progress: { processed_count: 1, clean_pass: false },
    });
    expect(deletedContacts(fetchSpy)).toEqual(['contact-1']);

    const activities = await db
      .select()
      .from(user_deletion_activity)
      .where(eq(user_deletion_activity.request_id, request.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'pylon_contact_extra_email',
          details_json: { resource_hmac: hmacDeletionEmail(EXTRA_EMAIL) },
        }),
      ])
    );
  });
});

async function setupContactRequest() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({ google_user_email: TARGET_EMAIL });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: TARGET_EMAIL, ...(user ? { trustedUserId: user.id } : {}) }],
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
        eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonContact)
      )
    );
  if (!step) {
    const [inserted] = await db
      .insert(user_deletion_steps)
      .values({
        request_id: request.id,
        step_key: UserDeletionStepKey.PylonContact,
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
    stepKey: UserDeletionStepKey.PylonContact,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
  return { request, step: claimed, context };
}

function mockPylon(params: {
  contacts?: Array<{ id: string; email?: string; emails?: string[] }>;
  searchBody?: unknown;
}) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/contacts/search') && method === 'POST') {
      return jsonResponse(
        params.searchBody ?? {
          data: params.contacts ?? [],
          pagination: { has_next_page: false },
        }
      );
    }
    const deleteMatch = url.match(/\/contacts\/([^/?]+)$/);
    if (deleteMatch && method === 'DELETE') {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

function deletedContacts(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([input]) => {
      const match = String(input).match(/\/contacts\/([^/?]+)$/);
      return match?.[1];
    });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
