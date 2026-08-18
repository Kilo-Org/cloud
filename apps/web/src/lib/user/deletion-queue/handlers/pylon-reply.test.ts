import { and, eq } from 'drizzle-orm';
import { user_deletion_requests, user_deletion_steps } from '@kilocode/db/schema';
import {
  UserDeletionPylonReplyState,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { USER_DELETION_PYLON_REPLY_TEXT } from '@/lib/user/deletion-queue/deletion-constants';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { handlePylonReply } from '@/lib/user/deletion-queue/handlers/pylon-reply';
import { insertTestUser } from '@/tests/helpers/user.helper';

const ISSUE_ID = 'iss-case';
const TARGET_EMAIL = 'user@example.com';
const REPLY_HTML = `<p>${USER_DELETION_PYLON_REPLY_TEXT}</p>`;
const AUTHOR_USER_ID = 'pylon-bot';

describe('handlePylonReply', () => {
  const originalApiKey = process.env.PYLON_API_KEY;
  const originalAuthor = process.env.PYLON_FINAL_EMAIL_AUTHOR_USER_ID;

  beforeEach(async () => {
    await cleanupDbForTest();
    process.env.PYLON_API_KEY = 'test-pylon-key';
    process.env.PYLON_FINAL_EMAIL_AUTHOR_USER_ID = AUTHOR_USER_ID;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiKey === undefined) delete process.env.PYLON_API_KEY;
    else process.env.PYLON_API_KEY = originalApiKey;
    if (originalAuthor === undefined) delete process.env.PYLON_FINAL_EMAIL_AUTHOR_USER_ID;
    else process.env.PYLON_FINAL_EMAIL_AUTHOR_USER_ID = originalAuthor;
  });

  it('accepts a mixed-case Pylon requester against the stored Cloud email', async () => {
    const { request, step, context } = await setupReplyRequest({
      googleUserEmail: 'User@Example.com',
      paste: 'user@example.com',
    });
    mockPylon({
      requesterEmail: 'user@example.com',
      state: 'closed',
      messages: [customerMessage(), matchingReply()],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
  });

  it('accepts a mixed-case Pylon requester against a lowercased stored email', async () => {
    const { request, step, context } = await setupReplyRequest({
      paste: 'user@example.com',
    });
    mockPylon({
      requesterEmail: 'User@Example.com',
      state: 'closed',
      messages: [customerMessage(), matchingReply()],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
  });

  it('posts the deletion reply, persists its id, and closes the issue', async () => {
    const { request, step, context } = await setupReplyRequest();
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'open',
      messages: [customerMessage()],
      replyId: 'msg-posted',
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome).toEqual({
      kind: 'succeeded',
      progress: {
        reply_state: UserDeletionPylonReplyState.Posted,
        reply_message_id: 'msg-posted',
        close_confirmed: true,
      },
    });
    expect(postedBodies(fetchSpy)).toHaveLength(1);
    expect(closedIssue(fetchSpy)).toBe(true);
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_state: UserDeletionPylonReplyState.Posted,
      reply_message_id: 'msg-posted',
    });
  });

  it('reuses an existing matching reply instead of posting', async () => {
    const { request, step, context } = await setupReplyRequest();
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'closed',
      messages: [customerMessage(), matchingReply({ id: 'msg-existing' })],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(postedBodies(fetchSpy)).toHaveLength(0);
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_state: UserDeletionPylonReplyState.Posted,
      reply_message_id: 'msg-existing',
    });
  });

  it('finds a matching reply on a later page and does not post', async () => {
    const { request, step, context } = await setupReplyRequest();
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'closed',
      pages: [
        { messages: [customerMessage()], cursor: 'page-2' },
        { messages: [matchingReply({ id: 'msg-page-2' })] },
      ],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(postedBodies(fetchSpy)).toHaveLength(0);
    expect(messageUrls(fetchSpy)).toEqual([
      expect.stringMatching(/\/messages$/),
      expect.stringMatching(/\/messages\?cursor=page-2$/),
    ]);
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_message_id: 'msg-page-2',
    });
  });

  it('ignores old, wrong-recipient, wrong-author, and other-thread replies', async () => {
    const { request, step, context } = await setupReplyRequest();
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'open',
      messages: [
        customerMessage(),
        matchingReply({
          id: 'msg-old',
          timestamp: '2020-01-01T00:00:00.000Z',
        }),
        matchingReply({
          id: 'msg-wrong-recipient',
          threadId: 'thread-other',
          toEmails: ['other@example.com'],
        }),
        matchingReply({
          id: 'msg-wrong-author',
          authorUserId: 'someone-else',
        }),
      ],
      replyId: 'msg-new',
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(postedBodies(fetchSpy)).toHaveLength(1);
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_message_id: 'msg-new',
    });
  });

  it('marks the reply ambiguous after a timeout that may have posted', async () => {
    const { request, step, context } = await setupReplyRequest();
    mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'open',
      messages: [customerMessage()],
      replyError: Object.assign(new Error('The operation timed out'), { name: 'AbortError' }),
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome).toEqual({
      kind: 'retry',
      errorCode: 'timeout',
      httpStatusClass: 'timeout',
    });
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_state: UserDeletionPylonReplyState.Ambiguous,
    });
  });

  it('completes a later retry by finding the created message without posting again', async () => {
    const { request, context } = await setupReplyRequest({
      progress: { reply_state: UserDeletionPylonReplyState.Ambiguous },
    });
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, request.id),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonReply)
        )
      );
    if (!step) throw new Error('missing step');
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'closed',
      messages: [customerMessage(), matchingReply({ id: 'msg-recovered' })],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(postedBodies(fetchSpy)).toHaveLength(0);
    await expect(loadProgress(request.id)).resolves.toMatchObject({
      reply_state: UserDeletionPylonReplyState.Posted,
      reply_message_id: 'msg-recovered',
    });
  });

  it('stops without posting when an ambiguous reply cannot be found', async () => {
    const { request, context } = await setupReplyRequest({
      progress: { reply_state: UserDeletionPylonReplyState.Posting },
    });
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, request.id),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonReply)
        )
      );
    if (!step) throw new Error('missing step');
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'open',
      messages: [customerMessage()],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome).toEqual({
      kind: 'needs_attention',
      errorCode: 'pylon_reply_inconclusive',
    });
    expect(postedBodies(fetchSpy)).toHaveLength(0);
  });

  it('backs off only this step on 429 and remains retryable', async () => {
    const { request, step, context } = await setupReplyRequest();
    mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'open',
      messages: [customerMessage()],
      replyStatus: 429,
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('rate_limited');
    await expect(loadProgress(request.id)).resolves.toEqual({});
  });

  it('does not post again after a crash that saved posting but not the response', async () => {
    const { request, context } = await setupReplyRequest({
      progress: { reply_state: UserDeletionPylonReplyState.Posting },
    });
    const [step] = await db
      .select()
      .from(user_deletion_steps)
      .where(
        and(
          eq(user_deletion_steps.request_id, request.id),
          eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonReply)
        )
      );
    if (!step) throw new Error('missing step');
    const fetchSpy = mockPylon({
      requesterEmail: TARGET_EMAIL,
      state: 'closed',
      messages: [customerMessage(), matchingReply({ id: 'msg-after-crash' })],
    });

    const outcome = await handlePylonReply({ request, step, context });
    expect(outcome.kind).toBe('succeeded');
    expect(postedBodies(fetchSpy)).toHaveLength(0);
  });
});

async function setupReplyRequest(params?: {
  googleUserEmail?: string;
  paste?: string;
  progress?: UserDeletionTaskProgress;
}) {
  const paste = params?.paste ?? TARGET_EMAIL;
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: params?.googleUserEmail ?? paste,
  });
  const [result] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [
      {
        email: paste,
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
        eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonReply)
      )
    );
  if (!step) {
    const [inserted] = await db
      .insert(user_deletion_steps)
      .values({
        request_id: request.id,
        step_key: UserDeletionStepKey.PylonReply,
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
      progress_json: params?.progress ?? {},
    })
    .where(eq(user_deletion_steps.id, step.id))
    .returning();
  if (!claimed) throw new Error('missing claimed step');

  const context: DeletionHandlerContext = {
    requestId: request.id,
    stepKey: UserDeletionStepKey.PylonReply,
    claimToken,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    signal: new AbortController().signal,
  };
  return { request, step: claimed, context };
}

async function loadProgress(requestId: string): Promise<UserDeletionTaskProgress> {
  const [step] = await db
    .select({ progress_json: user_deletion_steps.progress_json })
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.PylonReply)
      )
    );
  return step?.progress_json ?? {};
}

function customerMessage() {
  return {
    id: 'msg-customer',
    is_private: false,
    thread_id: 'thread-1',
    timestamp: '2026-08-18T00:00:00.000Z',
    message_html: '<p>Please delete my account</p>',
    author: { contact: { email: TARGET_EMAIL } },
    email_info: { from_email: TARGET_EMAIL },
  };
}

function matchingReply(overrides?: {
  id?: string;
  timestamp?: string;
  threadId?: string;
  toEmails?: string[];
  authorUserId?: string;
}) {
  return {
    id: overrides?.id ?? 'msg-reply',
    is_private: false,
    thread_id: overrides?.threadId ?? 'thread-1',
    timestamp: overrides?.timestamp ?? '2099-01-01T00:00:00.000Z',
    message_html: REPLY_HTML,
    author: { user: { id: overrides?.authorUserId ?? AUTHOR_USER_ID } },
    email_info: { to_emails: overrides?.toEmails ?? [TARGET_EMAIL] },
  };
}

function mockPylon(params: {
  requesterEmail: string;
  state: string;
  messages?: unknown[];
  pages?: Array<{ messages: unknown[]; cursor?: string }>;
  replyId?: string;
  replyStatus?: number;
  replyError?: Error;
}) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes(`/issues/${ISSUE_ID}/messages`)) {
      const cursor = new URL(url).searchParams.get('cursor');
      if (params.pages) {
        const page = cursor
          ? params.pages.find((_, index) => params.pages?.[index - 1]?.cursor === cursor)
          : params.pages[0];
        if (!page) throw new Error(`unexpected messages cursor ${cursor}`);
        return jsonResponse({
          data: page.messages,
          pagination: page.cursor
            ? { has_next_page: true, cursor: page.cursor }
            : { has_next_page: false },
        });
      }
      return jsonResponse({
        data: params.messages ?? [],
        pagination: { has_next_page: false },
      });
    }
    if (url.endsWith(`/issues/${ISSUE_ID}/reply`) && method === 'POST') {
      if (params.replyError) {
        if (params.replyError.name === 'AbortError') {
          throw new DOMException(params.replyError.message, 'AbortError');
        }
        throw params.replyError;
      }
      if (params.replyStatus && params.replyStatus !== 200) {
        return new Response('rate limited', { status: params.replyStatus });
      }
      return jsonResponse({ data: { id: params.replyId ?? 'msg-posted' } });
    }
    if (url.endsWith(`/issues/${ISSUE_ID}`) && method === 'PATCH') {
      return jsonResponse({ data: { id: ISSUE_ID, state: 'closed' } });
    }
    if (url.endsWith(`/issues/${ISSUE_ID}`)) {
      return jsonResponse({
        data: {
          id: ISSUE_ID,
          requester: { email: params.requesterEmail },
          source: 'email',
          state: params.state,
        },
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

function postedBodies(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls.filter(([input, init]) => {
    return String(input).endsWith('/reply') && (init?.method ?? 'GET') === 'POST';
  });
}

function closedIssue(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls.some(([input, init]) => {
    return String(input).endsWith(`/issues/${ISSUE_ID}`) && init?.method === 'PATCH';
  });
}

function messageUrls(fetchSpy: jest.SpiedFunction<typeof fetch>) {
  return fetchSpy.mock.calls
    .map(([input]) => String(input))
    .filter(url => url.includes('/messages'));
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
