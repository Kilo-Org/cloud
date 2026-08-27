import { and, eq } from 'drizzle-orm';
import {
  user_deletion_activity,
  user_deletion_requests,
  user_deletion_steps,
} from '@kilocode/db/schema';
import { UserDeletionStepKey, UserDeletionStepStatus } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { USER_DELETION_DEFAULT_POSTHOG_HOST } from '@/lib/user/deletion-queue/deletion-constants';
import { encryptDeletionResourceIds } from '@/lib/user/deletion-queue/deletion-crypto';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { hmacResourceRef } from '@/lib/user/deletion-queue/deletion-hmac';
import { enqueueHistoricalUserDeletion } from '@/lib/user/deletion-queue/deletion-legacy-backfill';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import {
  getPostHogPersonsSearchUrl,
  handlePosthog,
} from '@/lib/user/deletion-queue/handlers/posthog';
import { insertTestUser } from '@/tests/helpers/user.helper';

const PERSON_A = 'person-a';
const PERSON_B = 'person-b';
const ENVIRONMENT_ID = 'proj-test';
const NUMERIC_ID = '999';
const KILO_USER_ID = 'oauth/GitHub/CaseSensitive+42';

describe('getPostHogPersonsSearchUrl', () => {
  const originalHost = process.env.POSTHOG_HOST;
  const originalProjectId = process.env.POSTHOG_ENVIRONMENT_ID;

  afterEach(() => {
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
    if (originalProjectId === undefined) delete process.env.POSTHOG_ENVIRONMENT_ID;
    else process.env.POSTHOG_ENVIRONMENT_ID = originalProjectId;
  });

  it('uses the project path and lowercases the search email', () => {
    process.env.POSTHOG_HOST = 'https://us.posthog.com/';
    process.env.POSTHOG_ENVIRONMENT_ID = ENVIRONMENT_ID;
    expect(getPostHogPersonsSearchUrl('  Customer@Example.com ')).toBe(
      `https://us.posthog.com/project/${ENVIRONMENT_ID}/persons?search=customer%40example.com`
    );
  });

  it('falls back to /persons when the project id is missing', () => {
    delete process.env.POSTHOG_HOST;
    delete process.env.POSTHOG_ENVIRONMENT_ID;
    expect(getPostHogPersonsSearchUrl('customer@example.com')).toBe(
      `${USER_DELETION_DEFAULT_POSTHOG_HOST}/persons?search=customer%40example.com`
    );
  });
});

describe('handlePosthog', () => {
  const originalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const originalProjectId = process.env.POSTHOG_ENVIRONMENT_ID;
  const originalHost = process.env.POSTHOG_HOST;

  beforeEach(async () => {
    await cleanupDbForTest();
    process.env.POSTHOG_PERSONAL_API_KEY = 'test-posthog-key';
    process.env.POSTHOG_ENVIRONMENT_ID = ENVIRONMENT_ID;
    delete process.env.POSTHOG_HOST;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiKey === undefined) delete process.env.POSTHOG_PERSONAL_API_KEY;
    else process.env.POSTHOG_PERSONAL_API_KEY = originalApiKey;
    if (originalProjectId === undefined) delete process.env.POSTHOG_ENVIRONMENT_ID;
    else process.env.POSTHOG_ENVIRONMENT_ID = originalProjectId;
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
  });

  it('deletes an exact user-ID match without requiring or looking up an email', async () => {
    const { request, step, context } = await setupUserIdRequest();
    const fetchSpy = mockPosthogFetch({
      email: 'former@example.com',
      persons: [
        {
          uuid: PERSON_A,
          id: NUMERIC_ID,
          emails: ['former@example.com'],
          distinctIds: [KILO_USER_ID, 'former@example.com'],
        },
      ],
    });

    await expect(
      handlePosthog({ request: { ...request, target_email: null }, step, context })
    ).resolves.toMatchObject({ kind: 'succeeded' });

    const lookupUrls = fetchSpy.mock.calls
      .map(call => String(call[0]))
      .filter(url => new URL(url).pathname.endsWith('/persons/'));
    expect(lookupUrls).toEqual([
      `${USER_DELETION_DEFAULT_POSTHOG_HOST}/api/environments/${ENVIRONMENT_ID}/persons/?distinct_id=${encodeURIComponent(KILO_USER_ID)}`,
    ]);
    const submit = fetchSpy.mock.calls.find(call =>
      String(call[0]).endsWith('/persons/bulk_delete/')
    );
    expect(JSON.parse(String(submit?.[1]?.body))).toEqual({
      ids: [PERSON_A],
      delete_events: true,
      delete_recordings: true,
      keep_person: false,
    });
  });

  it.each([null, KILO_USER_ID.toLowerCase(), 'unrelated-user'])(
    'skips absent or nonmatching user IDs without email fallback: %p',
    async distinctId => {
      const { request, step, context, email } = await setupUserIdRequest();
      const fetchSpy = mockPosthogFetch({
        email,
        persons:
          distinctId === null
            ? []
            : [{ uuid: PERSON_A, emails: [email], distinctIds: [distinctId] }],
      });

      await expect(handlePosthog({ request, step, context })).resolves.toEqual({
        kind: 'not_applicable',
      });
      expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
        `${USER_DELETION_DEFAULT_POSTHOG_HOST}/api/environments/${ENVIRONMENT_ID}/persons/?distinct_id=${encodeURIComponent(KILO_USER_ID)}`,
      ]);
    }
  );

  it('requires the user ID for an ID-only request instead of falling back to email', async () => {
    const { request, step, context } = await setupUserIdRequest();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      handlePosthog({ request: { ...request, user_id: null }, step, context })
    ).resolves.toEqual({ kind: 'needs_attention', errorCode: 'user_missing' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { results: [null] },
    { results: [{ uuid: PERSON_A }] },
    { results: [{ uuid: PERSON_A, distinct_ids: [null] }] },
    { results: [{ uuid: PERSON_A, distinct_ids: [KILO_USER_ID, null] }] },
    {
      results: [
        { uuid: PERSON_A, distinct_ids: [KILO_USER_ID] },
        { uuid: PERSON_B, distinct_ids: [null] },
      ],
    },
    { results: [], next: 'https://posthog.test/persons/?offset=100' },
  ])('does not treat an incomplete user-ID lookup as absence: %j', async payload => {
    const { request, step, context } = await setupUserIdRequest();
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));

    await expect(handlePosthog({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'posthog_lookup_incomplete',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('requires a UUID for a person matched by user ID', async () => {
    const { request, step, context } = await setupUserIdRequest();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ results: [{ id: NUMERIC_ID, distinct_ids: [KILO_USER_ID] }] })
      );

    await expect(handlePosthog({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'posthog_manual_required',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['reserved', 'submitted'])(
    'resumes an ID-only %s checkpoint without another deletion',
    async providerRef => {
      const { request, step, context } = await setupSubmittedEffect([PERSON_A], {
        providerRef,
        userIdOnly: true,
      });
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/persons/')) {
          expect(url.searchParams.get('distinct_id')).toBe(KILO_USER_ID);
          expect(url.searchParams.has('email')).toBe(false);
          return jsonResponse({ results: [] });
        }
        if (url.pathname.endsWith(`/persons/${PERSON_A}/`)) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.endsWith('/persons/deletion_status/')) {
          expect(url.searchParams.get('person_uuid')).toBe(PERSON_A);
          return completedDeletionStatus(PERSON_A);
        }
        throw new Error(`unexpected fetch ${url.pathname}`);
      });

      await expect(handlePosthog({ request, step, context })).resolves.toMatchObject({
        kind: 'succeeded',
      });
      expect(
        fetchSpy.mock.calls.some(call => String(call[0]).endsWith('/persons/bulk_delete/'))
      ).toBe(false);
      const lookups = fetchSpy.mock.calls.filter(call =>
        new URL(String(call[0])).pathname.endsWith('/persons/')
      );
      expect(lookups).toHaveLength(providerRef === 'reserved' ? 1 : 0);
    }
  );

  it('looks up by distinct_id and email on environments URLs with trailing slashes', async () => {
    const { request, step, context, email } = await setupLookupRequest();
    const fetchSpy = mockPosthogFetch({
      email,
      persons: [{ uuid: PERSON_A, emails: [email] }],
    });

    await handlePosthog({ request, step, context });

    const urls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(urls).toContain(
      `${USER_DELETION_DEFAULT_POSTHOG_HOST}/api/environments/${ENVIRONMENT_ID}/persons/?distinct_id=${encodeURIComponent(email)}`
    );
    expect(urls).toContain(
      `${USER_DELETION_DEFAULT_POSTHOG_HOST}/api/environments/${ENVIRONMENT_ID}/persons/?email=${encodeURIComponent(email)}`
    );
    expect(urls.some(url => url.endsWith('/persons/bulk_delete/'))).toBe(true);
  });

  it('deletes by uuid, not id, and sends recordings plus keep_person false', async () => {
    const { request, step, context, email } = await setupLookupRequest();
    const fetchSpy = mockPosthogFetch({
      email,
      persons: [{ uuid: PERSON_A, id: NUMERIC_ID, emails: [email] }],
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).toBe('succeeded');

    const submit = fetchSpy.mock.calls.find(call =>
      String(call[0]).endsWith('/persons/bulk_delete/')
    );
    expect(submit).toBeDefined();
    const init = submit?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      ids: [PERSON_A],
      delete_events: true,
      delete_recordings: true,
      keep_person: false,
    });
  });

  it('requires full bulk-delete acceptance', async () => {
    const { request, step, context, email } = await setupLookupRequest();
    mockPosthogFetch({
      email,
      persons: [{ uuid: PERSON_A, emails: [email] }],
      acceptance: {
        persons_found: 1,
        persons_deleted: 1,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      },
    });

    await expect(handlePosthog({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
  });

  it('returns needs_attention when bulk-delete acceptance is incomplete', async () => {
    const { request, step, context, email } = await setupLookupRequest();
    mockPosthogFetch({
      email,
      persons: [{ uuid: PERSON_A, emails: [email] }],
      acceptance: {
        persons_found: 1,
        persons_deleted: 0,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      },
    });

    await expect(handlePosthog({ request, step, context })).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'posthog_acceptance_incomplete',
    });
  });

  it('deletes a shared person instead of blocking', async () => {
    const extra = await insertTestUser({
      google_user_email: `extra-${crypto.randomUUID()}@example.com`,
    });
    const { request, step, context, email } = await setupLookupRequest();
    mockPosthogFetch({
      email,
      persons: [{ uuid: PERSON_A, emails: [email, extra.google_user_email] }],
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).not.toBe('needs_attention');
    expect(outcome.kind).toBe('succeeded');

    const activity = await db
      .select()
      .from(user_deletion_activity)
      .where(
        and(
          eq(user_deletion_activity.request_id, request.id),
          eq(user_deletion_activity.event_type, 'posthog_shared_identity')
        )
      );
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details_json: { resource_hmac: hmacResourceRef(extra.id) },
        }),
      ])
    );
  });

  it('returns manual_action_required on 401', async () => {
    const { request, step, context } = await setupLookupRequest();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(handlePosthog({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'posthog_manual_required',
    });
  });

  it('returns manual_action_required when a person has no uuid', async () => {
    const { request, step, context, email } = await setupLookupRequest();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/persons/?')) {
        return jsonResponse({
          results: [{ id: NUMERIC_ID, distinct_ids: [email], properties: { email } }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(handlePosthog({ request, step, context })).resolves.toEqual({
      kind: 'manual_action_required',
      errorCode: 'posthog_manual_required',
    });
  });

  it('succeeds after three pending verification continues', async () => {
    const { request, context } = await setupSubmittedEffect([PERSON_A]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/persons/${PERSON_A}/`)) return jsonResponse({ uuid: PERSON_A });
      throw new Error(`unexpected fetch ${url}`);
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const step = await loadStep(request.id);
      const outcome = await handlePosthog({ request, step, context });
      expect(outcome.kind).toBe('continue');
      if (outcome.kind !== 'continue') throw new Error('expected continue');
      expect(outcome.progress?.verify_attempt_count).toBe(attempt);
    }

    const finalStep = await loadStep(request.id);
    const outcome = await handlePosthog({ request, step: finalStep, context });
    expect(outcome.kind).toBe('succeeded');
  });

  it('does not succeed when the first person is gone but another remains', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B]);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/persons/${PERSON_A}/`)) return new Response(null, { status: 404 });
      if (url.includes('deletion_status/') && url.includes(`person_uuid=${PERSON_A}`)) {
        return completedDeletionStatus(PERSON_A);
      }
      if (url.endsWith(`/persons/${PERSON_B}/`)) return jsonResponse({ uuid: PERSON_B });
      throw new Error(`unexpected fetch ${url}`);
    });

    const outcome = await handlePosthog({ request, step, context });
    expect(outcome.kind).toBe('continue');
  });

  it('succeeds a reserved checkpoint when the email lookup is empty and checkpointed persons are gone', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B], {
      providerRef: 'reserved',
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/persons/?')) return jsonResponse({ results: [] });
      if (url.endsWith(`/persons/${PERSON_A}/`) || url.endsWith(`/persons/${PERSON_B}/`)) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('deletion_status/')) {
        const personUuid = new URL(url).searchParams.get('person_uuid') ?? '';
        return completedDeletionStatus(personUuid);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(handlePosthog({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
  });

  it('succeeds when every checkpointed person is gone and deletion_status is completed', async () => {
    const { request, step, context } = await setupSubmittedEffect([PERSON_A, PERSON_B]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith(`/persons/${PERSON_A}/`) || url.endsWith(`/persons/${PERSON_B}/`)) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('deletion_status/')) {
        const personUuid = new URL(url).searchParams.get('person_uuid') ?? '';
        return completedDeletionStatus(personUuid);
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await expect(handlePosthog({ request, step, context })).resolves.toMatchObject({
      kind: 'succeeded',
    });
    expect(fetchSpy).toHaveBeenCalled();
  });
});

type MockPerson = {
  uuid: string;
  id?: string;
  emails: string[];
  distinctIds?: string[];
};

type AcceptanceBody = {
  persons_found: number;
  persons_deleted: number;
  events_queued_for_deletion: boolean;
  recordings_queued_for_deletion: boolean;
  deletion_errors: unknown[];
};

function mockPosthogFetch(options: {
  email: string;
  persons: MockPerson[];
  acceptance?: AcceptanceBody;
}): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/persons/') && parsed.searchParams.has('distinct_id')) {
      return personsLookupResponse(options.persons);
    }
    if (parsed.pathname.endsWith('/persons/') && parsed.searchParams.has('email')) {
      return personsLookupResponse(options.persons);
    }
    if (parsed.pathname.endsWith('/persons/bulk_delete/')) {
      const ids = options.persons.map(person => person.uuid);
      const acceptance = options.acceptance ?? {
        persons_found: ids.length,
        persons_deleted: ids.length,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      };
      expect(init?.method).toBe('POST');
      return jsonResponse({ id: 'deletion-mock', ...acceptance }, 202);
    }
    const personMatch = parsed.pathname.match(/\/persons\/([^/]+)\/$/);
    if (personMatch && !parsed.pathname.includes('deletion_status')) {
      return new Response(null, { status: 404 });
    }
    if (parsed.pathname.endsWith('/persons/deletion_status/')) {
      const personUuid = parsed.searchParams.get('person_uuid') ?? '';
      return completedDeletionStatus(personUuid);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function personsLookupResponse(persons: MockPerson[]): Response {
  return jsonResponse({
    results: persons.map(person => ({
      uuid: person.uuid,
      id: person.id ?? person.uuid,
      distinct_ids: person.distinctIds ?? person.emails,
      properties: { email: person.emails[0] },
    })),
  });
}

function completedDeletionStatus(
  personUuid: string,
  createdAt = new Date().toISOString()
): Response {
  return jsonResponse({
    results: [
      {
        person_uuid: personUuid,
        status: 'completed',
        created_at: createdAt,
        delete_verified_at: createdAt,
      },
    ],
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function setupLookupRequest() {
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

  const { request, step, context } = await loadRunningStep(result.requestId);
  return { request, step, context, email: user.google_user_email };
}

async function setupUserIdRequest() {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    id: KILO_USER_ID,
    google_user_email: `deleted+${KILO_USER_ID}@deleted.invalid`,
    blocked_reason: 'soft-deleted at 2026-08-26T00:00:00.000Z',
  });
  const result = await enqueueHistoricalUserDeletion({
    userId: user.id,
    adminUserId: admin.id,
    execute: true,
  });
  if (result.status !== 'enqueued') throw new Error(`expected enqueued, got ${result.status}`);
  const { request, step, context } = await loadRunningStep(result.requestId);
  return { request, step, context, email: user.google_user_email };
}

async function setupSubmittedEffect(
  personIds: string[],
  options: { providerRef?: string; userIdOnly?: boolean } = {}
) {
  const { request, context, email } = await (options.userIdOnly
    ? setupUserIdRequest()
    : setupLookupRequest());
  await db
    .update(user_deletion_steps)
    .set({
      progress_json: {
        provider_ref: options.providerRef ?? 'submitted',
        encrypted_resource_ids: encryptDeletionResourceIds(personIds),
        checkpoint_at: new Date().toISOString(),
      },
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, request.id),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );
  const step = await loadStep(request.id);
  return { request, step, context, email };
}

async function loadRunningStep(requestId: string) {
  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, requestId));
  if (!request) throw new Error('missing request');

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.Posthog,
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
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );

  const step = await loadStep(request.id);
  return { request, step, context };
}

async function loadStep(requestId: string) {
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.Posthog)
      )
    );
  if (!step) throw new Error('missing step');
  return step;
}
