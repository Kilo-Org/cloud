import { and, eq, inArray } from 'drizzle-orm';
import {
  microdollar_usage,
  microdollar_usage_metadata,
  system_prompt_prefix,
  user_deletion_requests,
  user_deletion_steps,
  type UserDeletionStep,
} from '@kilocode/db/schema';
import {
  UserDeletionRequestStatus,
  UserDeletionStepKey,
  UserDeletionStepStatus,
  type UserDeletionTaskProgress,
} from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { USER_DELETION_USAGE_PREFIX_BATCH_SIZE } from '@/lib/user/deletion-queue/deletion-constants';
import { enqueueUserDeletionTargets } from '@/lib/user/deletion-queue/deletion-enqueue';
import { handleUsagePromptPrefixes } from '@/lib/user/deletion-queue/handlers/usage-prompt-prefixes';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('handleUsagePromptPrefixes', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns not_applicable when the user has no usage rows', async () => {
    const { request, step, claimToken } = await prepareRunningStep();

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, claimToken),
      })
    ).resolves.toEqual({ kind: 'not_applicable' });
  });

  it('scrubs only the target user prompt metadata', async () => {
    const { user: target, request, step, claimToken } = await prepareRunningStep();
    const other = await insertTestUser({
      google_user_email: `other-${crypto.randomUUID()}@example.com`,
    });
    const [systemPrefix] = await db
      .insert(system_prompt_prefix)
      .values({ system_prompt_prefix: `private system prefix ${crypto.randomUUID()}` })
      .returning({ id: system_prompt_prefix.system_prompt_prefix_id });
    if (!systemPrefix) throw new Error('expected system prompt prefix');

    const targetUsage = await insertUsage(target.id, 'target prompt', systemPrefix.id, 1);
    const otherUsage = await insertUsage(other.id, 'other prompt', systemPrefix.id, 2);

    const outcome = await handleUsagePromptPrefixes({
      request,
      step,
      context: handlerContext(request.id, claimToken),
    });

    expect(outcome.kind).toBe('succeeded');
    const [targetMetadata, otherMetadata] = await Promise.all([
      loadMetadata(targetUsage),
      loadMetadata(otherUsage),
    ]);
    expect(targetMetadata).toMatchObject({
      user_prompt_prefix: null,
      system_prompt_prefix_id: null,
      max_tokens: 1,
      latency: 1,
    });
    expect(otherMetadata).toMatchObject({
      user_prompt_prefix: 'other prompt',
      system_prompt_prefix_id: systemPrefix.id,
      max_tokens: 2,
      latency: 2,
    });
  });

  it('commits a cursor and resumes at the next page', async () => {
    const { user, request, step, claimToken } = await prepareRunningStep();
    const rows = await insertUsageRows(user.id, USER_DELETION_USAGE_PREFIX_BATCH_SIZE + 1);

    const first = await handleUsagePromptPrefixes({
      request,
      step,
      context: handlerContext(request.id, claimToken),
    });
    expect(first.kind).toBe('continue');
    if (first.kind !== 'continue') throw new Error('expected first page to continue');
    expect(first.progress?.processed_count).toBe(USER_DELETION_USAGE_PREFIX_BATCH_SIZE);
    expect(first.progress?.scanned_count).toBe(USER_DELETION_USAGE_PREFIX_BATCH_SIZE);
    expect(first.progress?.cursor).toContain('\t');

    const firstPageIds = rows.slice(0, USER_DELETION_USAGE_PREFIX_BATCH_SIZE).map(row => row.id);
    const firstPage = await db
      .select({ user_prompt_prefix: microdollar_usage_metadata.user_prompt_prefix })
      .from(microdollar_usage_metadata)
      .where(inArray(microdollar_usage_metadata.id, firstPageIds));
    expect(firstPage.every(row => row.user_prompt_prefix === null)).toBe(true);

    const resumedStep = await loadStep(step.request_id);
    const nextClaimToken = crypto.randomUUID();
    await db
      .update(user_deletion_steps)
      .set({
        claim_token: nextClaimToken,
        claimed_until: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(user_deletion_steps.id, resumedStep.id));
    const nextClaimedStep = await loadStep(step.request_id);
    const second = await handleUsagePromptPrefixes({
      request,
      step: nextClaimedStep,
      context: handlerContext(request.id, nextClaimToken),
    });
    expect(second.kind).toBe('succeeded');
    if (second.kind !== 'succeeded') throw new Error('expected second page to succeed');
    expect(second.progress?.processed_count).toBe(rows.length);
    expect(second.progress?.scanned_count).toBe(rows.length);

    const remaining = await db
      .select({ user_prompt_prefix: microdollar_usage_metadata.user_prompt_prefix })
      .from(microdollar_usage_metadata)
      .where(
        inArray(
          microdollar_usage_metadata.id,
          rows.map(row => row.id)
        )
      );
    expect(remaining.every(row => row.user_prompt_prefix === null)).toBe(true);
  });

  it('advances over a page whose metadata is already null', async () => {
    const { user, request, step, claimToken } = await prepareRunningStep();
    await insertUsage(user.id, null, null, 1);

    const outcome = await handleUsagePromptPrefixes({
      request,
      step,
      context: handlerContext(request.id, claimToken),
    });

    expect(outcome).toMatchObject({
      kind: 'succeeded',
      progress: { processed_count: 0, scanned_count: 1 },
    });
  });

  it('keeps scanning already-clean pages in one claim until a dirty page finishes', async () => {
    const { user, request, step, claimToken } = await prepareRunningStep();
    await insertUsageRows(user.id, USER_DELETION_USAGE_PREFIX_BATCH_SIZE, null);
    const dirtyId = await insertUsage(user.id, 'still dirty', null, 2);

    const outcome = await handleUsagePromptPrefixes({
      request,
      step,
      context: handlerContext(request.id, claimToken),
    });

    expect(outcome).toMatchObject({
      kind: 'succeeded',
      progress: {
        processed_count: 1,
        scanned_count: USER_DELETION_USAGE_PREFIX_BATCH_SIZE + 1,
      },
    });
    const metadata = await loadMetadata(dirtyId);
    expect(metadata?.user_prompt_prefix).toBeNull();
  });

  it('yields continue after clean pages when the time budget is gone', async () => {
    const { user, request, step, claimToken } = await prepareRunningStep();
    await insertUsageRows(user.id, USER_DELETION_USAGE_PREFIX_BATCH_SIZE * 2, null);

    let remainingMs = 20_000;
    const outcome = await handleUsagePromptPrefixes({
      request,
      step,
      context: {
        ...handlerContext(request.id, claimToken),
        remainingMs: () => {
          const current = remainingMs;
          remainingMs = 1;
          return current;
        },
      },
    });

    expect(outcome).toMatchObject({
      kind: 'continue',
      progress: {
        processed_count: 0,
        scanned_count: USER_DELETION_USAGE_PREFIX_BATCH_SIZE,
      },
    });
  });

  it('returns unchanged progress when there is not enough time to start a page', async () => {
    const { request, step, claimToken } = await prepareRunningStep({ processed_count: 4 });
    const progress = step.progress_json;

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, claimToken, 1),
      })
    ).resolves.toEqual({ kind: 'continue', progress });
  });

  it('rejects malformed persisted progress without restarting the scan', async () => {
    const prepared = await prepareRunningStep({ cursor: 'not-a-cursor' });

    await expect(
      handleUsagePromptPrefixes({
        request: prepared.request,
        step: prepared.step,
        context: handlerContext(prepared.request.id, prepared.claimToken),
      })
    ).resolves.toEqual({
      kind: 'needs_attention',
      errorCode: 'usage_prefix_progress_invalid',
    });
  });

  it('rolls back the page when the claim is stale', async () => {
    const { user, request, step } = await prepareRunningStep();
    const usageId = await insertUsage(user.id, 'must remain', null, 1);

    await expect(
      handleUsagePromptPrefixes({
        request,
        step,
        context: handlerContext(request.id, crypto.randomUUID()),
      })
    ).resolves.toEqual({ kind: 'retry', errorCode: 'claim_lost', httpStatusClass: 'error' });

    const metadata = await loadMetadata(usageId);
    expect(metadata?.user_prompt_prefix).toBe('must remain');
  });
});

async function prepareRunningStep(progress: UserDeletionTaskProgress = {}) {
  const admin = await insertTestUser({ is_admin: true });
  const user = await insertTestUser({
    google_user_email: `target-${crypto.randomUUID()}@example.com`,
  });
  const [enqueued] = await enqueueUserDeletionTargets({
    actor: { kiloUserId: admin.id },
    targets: [{ email: user.google_user_email, trustedUserId: user.id }],
  });
  if (!enqueued || enqueued.status !== 'enqueued') {
    throw new Error('expected deletion request to be enqueued');
  }

  const claimToken = crypto.randomUUID();
  await db
    .update(user_deletion_requests)
    .set({ status: UserDeletionRequestStatus.InProgress })
    .where(eq(user_deletion_requests.id, enqueued.requestId));
  await db
    .update(user_deletion_steps)
    .set({
      status: UserDeletionStepStatus.Running,
      claim_token: claimToken,
      claimed_until: new Date(Date.now() + 60_000).toISOString(),
      progress_json: progress,
    })
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.UsagePromptPrefixes)
      )
    );

  const [request] = await db
    .select()
    .from(user_deletion_requests)
    .where(eq(user_deletion_requests.id, enqueued.requestId));
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, enqueued.requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.UsagePromptPrefixes)
      )
    );
  if (!request || !step) throw new Error('expected request and usage prompt step');
  return { user, request, step, claimToken };
}

async function loadStep(requestId: string): Promise<UserDeletionStep> {
  const [step] = await db
    .select()
    .from(user_deletion_steps)
    .where(
      and(
        eq(user_deletion_steps.request_id, requestId),
        eq(user_deletion_steps.step_key, UserDeletionStepKey.UsagePromptPrefixes)
      )
    );
  if (!step) throw new Error('expected usage prompt step');
  return step;
}

async function insertUsage(
  userId: string,
  userPromptPrefix: string | null,
  systemPromptPrefixId: number | null,
  value: number
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(microdollar_usage).values({
    id,
    kilo_user_id: userId,
    cost: value,
    input_tokens: value,
    output_tokens: value,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: new Date().toISOString(),
    provider: 'test',
    model: 'test',
    has_error: false,
  });
  await db.insert(microdollar_usage_metadata).values({
    id,
    message_id: `message-${id}`,
    user_prompt_prefix: userPromptPrefix,
    system_prompt_prefix_id: systemPromptPrefixId,
    max_tokens: value,
    latency: value,
  });
  return id;
}

async function insertUsageRows(userId: string, count: number, userPromptPrefix = 'private prompt') {
  const start = Date.parse('2020-01-01T00:00:00.000Z');
  const rows = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    createdAt: new Date(start + index).toISOString(),
  }));
  await db.insert(microdollar_usage).values(
    rows.map(row => ({
      id: row.id,
      kilo_user_id: userId,
      cost: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: row.createdAt,
      provider: 'test',
      model: 'test',
      has_error: false,
    }))
  );
  await db.insert(microdollar_usage_metadata).values(
    rows.map(row => ({
      id: row.id,
      message_id: `message-${row.id}`,
      user_prompt_prefix: userPromptPrefix,
      max_tokens: 1,
      latency: 1,
    }))
  );
  return rows;
}

async function loadMetadata(id: string) {
  const [metadata] = await db
    .select()
    .from(microdollar_usage_metadata)
    .where(eq(microdollar_usage_metadata.id, id));
  return metadata;
}

function handlerContext(
  requestId: string,
  claimToken: string,
  remainingMs = 60_000
): DeletionHandlerContext {
  return {
    requestId,
    stepKey: UserDeletionStepKey.UsagePromptPrefixes,
    claimToken,
    deadlineAt: Date.now() + remainingMs,
    remainingMs: () => remainingMs,
    signal: new AbortController().signal,
  };
}
