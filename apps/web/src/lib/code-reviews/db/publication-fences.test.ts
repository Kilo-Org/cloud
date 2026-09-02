import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_code_reviews,
  cloud_agent_code_review_attempts,
  kilocode_users,
  organizations,
  platform_integrations,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  githubPublicationTarget,
  type QueuedIsolateIdentity,
  type QueuedIsolateSafety,
} from '../queued-isolate-contract';
import {
  admitCodeReviewAttemptForDispatch,
  cancelCodeReview,
  createCodeReviewAttempt,
  pinCodeReviewAttemptReviewer,
  updateCodeReviewStatus,
} from './code-reviews';
import {
  acquireIsolatePublicationFence,
  assertFenceIdentity,
  blockCodeReviewOnPublicationFence,
  getActiveCodeReviewPublicationFence,
  isolateIdentityDigest,
  publicationFromAttempt,
  recordIsolatePublicationSafety,
  releaseIsolatePublicationFence,
  setIsolateWebFinalization,
  requestIsolateIdentityCleanup,
  updateIsolatePublicationOn,
} from './publication-fences';

describe('isolate publication fences', () => {
  let user: User;
  let organizationId: string;
  let integrationIds: string[];
  const reviewIds: string[] = [];

  beforeAll(async () => {
    user = await insertTestUser({ id: `oauth/github/fence-${crypto.randomUUID()}` });
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Publication fence tests' })
      .returning();
    organizationId = org.id;
    const integrations = await db
      .insert(platform_integrations)
      .values(
        [0, 1].map(() => ({
          owned_by_organization_id: organizationId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: crypto.randomUUID(),
          platform_account_id: crypto.randomUUID(),
          platform_account_login: 'fence-test',
          repository_access: 'all',
          integration_status: 'active',
        }))
      )
      .returning();
    integrationIds = integrations.map(integration => integration.id);
  });

  afterEach(async () => {
    if (!reviewIds.length) return;
    await db
      .delete(cloud_agent_code_reviews)
      .where(inArray(cloud_agent_code_reviews.id, reviewIds));
    reviewIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(platform_integrations).where(inArray(platform_integrations.id, integrationIds));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
  });

  async function candidate(
    options: { repo?: string; integration?: number; prNumber?: number; head?: string } = {}
  ) {
    const repo = options.repo ?? `fence/repo-${crypto.randomUUID()}`;
    const reservation = crypto.randomUUID();
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: organizationId,
        platform_integration_id: integrationIds[options.integration ?? 0],
        repo_full_name: repo,
        pr_number: options.prNumber ?? 1,
        pr_url: `https://github.com/${repo}/pull/${options.prNumber ?? 1}`,
        pr_title: 'Fence test',
        pr_author: 'author',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: options.head ?? 'a'.repeat(40),
        status: 'queued',
        dispatch_reservation_id: reservation,
      })
      .returning();
    reviewIds.push(review.id);
    const attempt = await admitCodeReviewAttemptForDispatch({
      codeReviewId: review.id,
      dispatchReservationId: reservation,
      previousStatus: 'pending',
    });
    const identity: QueuedIsolateIdentity = {
      reviewId: review.id,
      attemptId: attempt.id,
      generation: crypto.randomUUID(),
      organizationId,
      integrationId: integrationIds[options.integration ?? 0],
      executionUserId: user.id,
      target: githubPublicationTarget(repo, review.pr_number),
      snapshot: {
        headSha: review.head_sha,
        baseTipSha: 'b'.repeat(40),
        mergeBaseSha: 'c'.repeat(40),
      },
    };
    return { identity, dispatchReservationId: reservation };
  }

  async function readAttempt(identity: QueuedIsolateIdentity) {
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, identity.attemptId));
    if (!attempt) throw new Error('Expected code review attempt');
    return attempt;
  }

  async function readPublication(identity: QueuedIsolateIdentity) {
    const publication = publicationFromAttempt(await readAttempt(identity));
    if (!publication) throw new Error('Expected publication state');
    return publication;
  }

  function report(overrides: Partial<QueuedIsolateSafety> = {}): QueuedIsolateSafety {
    return {
      sequence: 1,
      execution: 'cancelled',
      cancellationRequested: true,
      publication: 'uncertain',
      quiescent: false,
      observedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function safelyRelease(identity: QueuedIsolateIdentity) {
    await recordIsolatePublicationSafety({
      identity,
      safety: report({ publication: 'settled', quiescent: true }),
    });
    await setIsolateWebFinalization({ identity, expected: 'pending', state: 'suppressed' });
    expect(await releaseIsolatePublicationFence(identity)).toBe(true);
  }

  it('stores publication metadata on the selected attempt and derives normalized relational fields', async () => {
    const input = await candidate();
    const unselected = await readAttempt(input.identity);
    expect(publicationFromAttempt(unselected)).toBeNull();
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ created_at: '2020-01-01T00:00:00Z' })
      .where(eq(cloud_agent_code_review_attempts.id, input.identity.attemptId));
    const acquired = await acquireIsolatePublicationFence(input);
    if (acquired.outcome !== 'acquired') throw new Error('Expected acquired fence');
    const attempt = await readAttempt(input.identity);
    expect(attempt.reviewer_selected_at).not.toBeNull();
    expect(acquired.fence.created_at).toBe(
      new Date(attempt.reviewer_selected_at ?? attempt.created_at).toISOString()
    );
    expect(attempt.publication_state?.identity).toEqual(input.identity);
    for (const key of [
      'generation',
      'code_review_id',
      'attempt_id',
      'repo_full_name',
      'pr_number',
      'created_at',
      'updated_at',
    ]) {
      expect(attempt.publication_state).not.toHaveProperty(key);
    }
    const databaseTimestamps = {
      ...attempt,
      created_at: '2026-04-28 01:16:12.945+00',
      reviewer_selected_at: '2026-04-29 01:16:12.945+00',
      updated_at: '2026-04-29 02:16:12.945+00',
    };
    expect(publicationFromAttempt(databaseTimestamps)).toMatchObject({
      generation: input.identity.generation,
      code_review_id: input.identity.reviewId,
      attempt_id: input.identity.attemptId,
      repo_full_name: input.identity.target.repoFullName,
      pr_number: input.identity.target.prNumber,
      created_at: '2026-04-29T01:16:12.945Z',
      updated_at: '2026-04-29T02:16:12.945Z',
    });
    expect(
      publicationFromAttempt({ ...databaseTimestamps, reviewer_selected_at: null })?.created_at
    ).toBe('2026-04-28T01:16:12.945Z');
  });

  it('merges concurrent publication updates without losing safety or cancellation state', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: '2020-01-01T00:00:00Z' })
      .where(eq(cloud_agent_code_review_attempts.id, input.identity.attemptId));
    const safety = report();
    const operation = {
      id: crypto.randomUUID(),
      kind: 'footer' as const,
      targetId: 22,
      state: 'sent' as const,
      body: 'Exact footer',
      previousBodyHash: 'd'.repeat(64),
    };
    const operationId = crypto.randomUUID();
    await Promise.all([
      recordIsolatePublicationSafety({ identity: input.identity, safety }),
      db.transaction(tx =>
        updateIsolatePublicationOn(tx, input.identity, { web_publications: [operation] })
      ),
      db.transaction(tx =>
        updateIsolatePublicationOn(tx, input.identity, { authorized_operation_ids: [operationId] })
      ),
      cancelCodeReview(input.identity.reviewId, input.identity.attemptId),
    ]);
    const attempt = await readAttempt(input.identity);
    expect(attempt.status).toBe('cancelled');
    expect(attempt.publication_state).toMatchObject({
      identity: input.identity,
      safety,
      web_publications: [operation],
      authorized_operation_ids: [operationId],
    });
    expect(new Date(attempt.updated_at).getTime()).toBeGreaterThan(Date.parse('2020-01-01'));
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
  });

  it('rejects mismatched update identities and attempts to rewrite the retained identity', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    const changed = {
      ...input.identity,
      snapshot: { ...input.identity.snapshot, baseTipSha: 'd'.repeat(40) },
    };
    await expect(
      db.transaction(tx => updateIsolatePublicationOn(tx, changed, { web_finalization: 'settled' }))
    ).rejects.toThrow('identity mismatch');
    await expect(
      db.transaction(tx => updateIsolatePublicationOn(tx, input.identity, { identity: changed }))
    ).rejects.toThrow('identity mismatch');
    expect((await readAttempt(input.identity)).publication_state).toMatchObject({
      identity: input.identity,
      web_finalization: 'pending',
    });
  });

  it('retains only immutable gate authorization before preparation and cleans it after safe release', async () => {
    const input = await candidate();
    await db
      .update(cloud_agent_code_reviews)
      .set({ check_run_id: 123 })
      .where(eq(cloud_agent_code_reviews.id, input.identity.reviewId));
    const acquired = await acquireIsolatePublicationFence(input);
    if (acquired.outcome !== 'acquired') throw new Error('Expected acquired fence');
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, input.identity.integrationId));
    expect(acquired.fence.gate_authorization).toEqual({
      installationId: integration.platform_installation_id,
      checkRunId: 123,
    });
    expect(acquired.fence.preparation).toBeNull();
    await db
      .update(cloud_agent_code_reviews)
      .set({ check_run_id: 456 })
      .where(eq(cloud_agent_code_reviews.id, input.identity.reviewId));
    const duplicate = await acquireIsolatePublicationFence(input);
    if (duplicate.outcome !== 'acquired') throw new Error('Expected existing fence');
    expect(duplicate.fence.gate_authorization).toEqual(acquired.fence.gate_authorization);
    await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
    const unresolved = await readPublication(input.identity);
    expect(unresolved.gate_authorization).toEqual(acquired.fence.gate_authorization);
    await safelyRelease(input.identity);
    const released = await readPublication(input.identity);
    expect(released.gate_authorization).toBeNull();
  });

  it('redacts released identities while keeping keyed callback evidence and wakeup recovery', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    await db.transaction(tx =>
      updateIsolatePublicationOn(tx, input.identity, {
        web_publications: [
          {
            id: crypto.randomUUID(),
            kind: 'footer',
            targetId: 22,
            state: 'confirmed',
            body: 'Private review footer',
          },
        ],
      })
    );
    await safelyRelease(input.identity);
    await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
    const released = await readPublication(input.identity);
    expect(released.identity.executionUserId).toBe('deleted');
    expect(released.identity_digest).toBe(isolateIdentityDigest(input.identity));
    expect(released.web_publications[0]).not.toHaveProperty('body');
    expect(() => assertFenceIdentity(released, input.identity)).not.toThrow();
    for (const identity of [
      released.identity,
      { ...input.identity, executionUserId: 'another-user' },
      { ...input.identity, snapshot: { ...input.identity.snapshot, baseTipSha: 'd'.repeat(40) } },
    ]) {
      expect(() => assertFenceIdentity(released, identity)).toThrow('identity mismatch');
    }
    const queueWakeupAt = new Date().toISOString();
    const recovered = await db.transaction(tx =>
      updateIsolatePublicationOn(tx, released.identity, { queue_wakeup_at: queueWakeupAt })
    );
    expect(recovered.queue_wakeup_at).toBe(queueWakeupAt);
    expect(recovered.identity_digest).toBe(released.identity_digest);
    await expect(
      db.transaction(tx =>
        updateIsolatePublicationOn(tx, released.identity, { web_finalization: 'settled' })
      )
    ).rejects.toThrow('identity mismatch');
    await expect(
      db.transaction(tx =>
        updateIsolatePublicationOn(tx, input.identity, { identity: input.identity })
      )
    ).rejects.toThrow('identity mismatch');
    await expect(
      db.transaction(tx =>
        updateIsolatePublicationOn(tx, input.identity, { identity_cleanup_requested: false })
      )
    ).rejects.toThrow('identity mismatch');
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(true);
  });

  it('races separate review IDs and case variants for one canonical GitHub target', async () => {
    const repo = `Fence/Race-${crypto.randomUUID()}`;
    const candidates = await Promise.all([
      candidate({ repo }),
      candidate({ repo: repo.toLowerCase(), integration: 1, head: 'd'.repeat(40) }),
    ]);
    const results = await Promise.all(candidates.map(acquireIsolatePublicationFence));
    expect(results.filter(result => result.outcome === 'acquired')).toHaveLength(1);
    expect(results.filter(result => result.outcome === 'blocked')).toHaveLength(1);
    const attempts = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(inArray(cloud_agent_code_review_attempts.code_review_id, reviewIds));
    expect(attempts.map(attempt => attempt.reviewer_backend).sort()).toEqual([
      'isolate',
      'unselected',
    ]);
    const [blocked] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(
        and(
          inArray(cloud_agent_code_reviews.id, reviewIds),
          isNotNull(cloud_agent_code_reviews.blocked_by_attempt_id)
        )
      );
    expect(blocked.status).toBe('pending');
    expect(blocked.dispatch_reservation_id).toBeNull();
    const holder = attempts.find(attempt => attempt.reviewer_backend === 'isolate');
    expect(blocked.blocked_by_attempt_id).toBe(holder?.id);
    expect(attempts.filter(attempt => attempt.publication_state !== null)).toHaveLength(1);
    expect(holder?.publication_state?.identity.target.repoFullName).toBe(repo.toLowerCase());
    expect(
      await acquireIsolatePublicationFence(await candidate({ repo, prNumber: 2 }))
    ).toMatchObject({ outcome: 'acquired' });
  });

  it('pins one winner when legacy selection races isolate acquisition', async () => {
    const input = await candidate();
    const [selection, acquisition] = await Promise.all([
      db.transaction(tx =>
        pinCodeReviewAttemptReviewer(tx, {
          codeReviewId: input.identity.reviewId,
          attemptId: input.identity.attemptId,
          dispatchReservationId: input.dispatchReservationId,
          backend: 'legacy',
        })
      ),
      acquireIsolatePublicationFence(input),
    ]);
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.id, input.identity.attemptId));
    expect(attempt.reviewer_execution_id).toBe(attempt.id);
    expect(selection.attempt.reviewer_backend).toBe(attempt.reviewer_backend);
    expect(acquisition.outcome).toBe(attempt.reviewer_backend === 'legacy' ? 'legacy' : 'acquired');
  });

  it('acquires idempotently and refuses to change the accepted identity or generation', async () => {
    const input = await candidate();
    const first = await acquireIsolatePublicationFence(input);
    expect(await acquireIsolatePublicationFence(input)).toEqual(first);
    for (const identity of [
      { ...input.identity, generation: crypto.randomUUID() },
      { ...input.identity, executionUserId: 'oauth/github/other' },
      { ...input.identity, snapshot: { ...input.identity.snapshot, baseTipSha: 'd'.repeat(40) } },
    ]) {
      await expect(acquireIsolatePublicationFence({ ...input, identity })).rejects.toThrow(
        'identity mismatch'
      );
    }
  });

  it('does not reacquire an old attempt when a newer attempt exists on the same review', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    await createCodeReviewAttempt({ codeReviewId: input.identity.reviewId });
    await expect(acquireIsolatePublicationFence(input)).rejects.toThrow('not current');
    const retained = await db.transaction(tx =>
      getActiveCodeReviewPublicationFence(tx, input.identity.target)
    );
    expect(retained?.generation).toBe(input.identity.generation);
    expect(retained?.released_at).toBeNull();
  });

  it('retains unresolved evidence after cancellation, reservation expiry and identity cleanup requests', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    const safety = report();
    await recordIsolatePublicationSafety({ identity: input.identity, safety });
    await updateCodeReviewStatus(input.identity.reviewId, 'cancelled', {
      terminalReason: 'superseded',
    });
    await db
      .update(cloud_agent_code_reviews)
      .set({ dispatch_reservation_id: null, updated_at: '2020-01-01T00:00:00Z' })
      .where(eq(cloud_agent_code_reviews.id, input.identity.reviewId));
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
    await expect(acquireIsolatePublicationFence(input)).rejects.toThrow('reservation changed');
    await db.transaction(tx => requestIsolateIdentityCleanup(tx, user.id));
    const fence = await db.transaction(tx =>
      getActiveCodeReviewPublicationFence(tx, input.identity.target)
    );
    expect(fence?.safety).toEqual(safety);
    expect(fence?.identity).toEqual(input.identity);
    expect(fence?.identity_cleanup_requested).toBe(true);
    const attempt = await readAttempt(input.identity);
    if (!attempt.publication_state) throw new Error('Expected retained publication state');
    expect(attempt.publication_state.safety).toEqual(safety);
    await expect(
      db
        .update(cloud_agent_code_review_attempts)
        .set({
          publication_state: {
            ...attempt.publication_state,
            released_at: new Date().toISOString(),
            web_finalization: 'suppressed',
          },
        })
        .where(eq(cloud_agent_code_review_attempts.id, input.identity.attemptId))
    ).rejects.toThrow();
  });

  it('blocks a legacy successor until worker quiescence AND web publication safety, retaining its blocker until advancement', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    await recordIsolatePublicationSafety({ identity: input.identity, safety: report() });
    await updateCodeReviewStatus(input.identity.reviewId, 'cancelled');
    const successor = await candidate({
      repo: input.identity.target.repoFullName,
      head: 'd'.repeat(40),
    });
    const blocked = await db.transaction(tx =>
      blockCodeReviewOnPublicationFence(tx, {
        reviewId: successor.identity.reviewId,
        attemptId: successor.identity.attemptId,
        dispatchReservationId: successor.dispatchReservationId,
        target: successor.identity.target,
      })
    );
    expect(blocked?.generation).toBe(input.identity.generation);
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
    await setIsolateWebFinalization({
      identity: input.identity,
      expected: 'pending',
      state: 'uncertain',
    });
    await recordIsolatePublicationSafety({
      identity: input.identity,
      safety: report({ sequence: 2, publication: 'settled', quiescent: true }),
    });
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
    await expect(
      setIsolateWebFinalization({
        identity: input.identity,
        expected: 'uncertain',
        state: 'suppressed',
      })
    ).rejects.toThrow('unresolved');
    await setIsolateWebFinalization({
      identity: input.identity,
      expected: 'uncertain',
      state: 'settled',
    });
    await expect(
      releaseIsolatePublicationFence({ ...input.identity, generation: crypto.randomUUID() })
    ).rejects.toThrow('not found');
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(true);
    const [wakeup] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(wakeup.status).toBe('pending');
    expect(wakeup.blocked_by_attempt_id).toBe(input.identity.attemptId);
    expect((await readPublication(input.identity)).released_at).not.toBeNull();
    await db
      .update(cloud_agent_code_reviews)
      .set({ status: 'queued', dispatch_reservation_id: successor.dispatchReservationId })
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(
      await db.transaction(tx =>
        blockCodeReviewOnPublicationFence(tx, {
          reviewId: successor.identity.reviewId,
          attemptId: successor.identity.attemptId,
          dispatchReservationId: successor.dispatchReservationId,
          target: successor.identity.target,
        })
      )
    ).toBeNull();
    const [reserved] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(reserved.blocked_by_attempt_id).toBeNull();
    const selection = await db.transaction(tx =>
      pinCodeReviewAttemptReviewer(tx, {
        codeReviewId: successor.identity.reviewId,
        attemptId: successor.identity.attemptId,
        dispatchReservationId: successor.dispatchReservationId,
        backend: 'legacy',
      })
    );
    expect(selection.attempt.reviewer_backend).toBe('legacy');
  });

  it('requires exact web-operation outcomes even when the aggregate finalization label is safe', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    await recordIsolatePublicationSafety({
      identity: input.identity,
      safety: report({ publication: 'settled', quiescent: true }),
    });
    const operation = {
      id: crypto.randomUUID(),
      kind: 'footer' as const,
      targetId: 22,
      state: 'sent' as const,
      body: 'Exact footer',
      previousBodyHash: 'd'.repeat(64),
    };
    await db.transaction(tx =>
      updateIsolatePublicationOn(tx, input.identity, { web_publications: [operation] })
    );
    await setIsolateWebFinalization({
      identity: input.identity,
      expected: 'pending',
      state: 'settled',
    });
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
    await db
      .update(cloud_agent_code_review_attempts)
      .set({ updated_at: '2020-01-01T00:00:00Z' })
      .where(eq(cloud_agent_code_review_attempts.id, input.identity.attemptId));
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(false);
    await db.transaction(tx =>
      updateIsolatePublicationOn(tx, input.identity, {
        web_publications: [{ ...operation, state: 'confirmed' }],
      })
    );
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(true);
  });

  it('released and historical legacy records never permanently classify a PR', async () => {
    const historical = await candidate();
    await db.transaction(tx =>
      pinCodeReviewAttemptReviewer(tx, {
        codeReviewId: historical.identity.reviewId,
        attemptId: historical.identity.attemptId,
        dispatchReservationId: historical.dispatchReservationId,
        backend: 'legacy',
      })
    );
    await updateCodeReviewStatus(historical.identity.reviewId, 'completed');
    const input = await candidate({
      repo: historical.identity.target.repoFullName,
      head: 'd'.repeat(40),
    });
    expect(await acquireIsolatePublicationFence(input)).toMatchObject({ outcome: 'acquired' });
    await safelyRelease(input.identity);
    await updateCodeReviewStatus(input.identity.reviewId, 'completed');
    const next = await candidate({
      repo: input.identity.target.repoFullName,
      head: 'e'.repeat(40),
    });
    expect(await acquireIsolatePublicationFence(next)).toMatchObject({ outcome: 'acquired' });
    expect(await releaseIsolatePublicationFence(input.identity)).toBe(true);
    const current = await db.transaction(tx =>
      getActiveCodeReviewPublicationFence(tx, next.identity.target)
    );
    expect(current?.generation).toBe(next.identity.generation);
    await expect(acquireIsolatePublicationFence(input)).rejects.toThrow();
  });

  it('records superseded-holder reports without touching its successor and rejects stale or regressing evidence', async () => {
    const input = await candidate();
    await acquireIsolatePublicationFence(input);
    const safety = report({ sequence: 2 });
    expect(await recordIsolatePublicationSafety({ identity: input.identity, safety })).toBe(
      'recorded'
    );
    expect(await recordIsolatePublicationSafety({ identity: input.identity, safety })).toBe(
      'duplicate'
    );
    expect(
      await recordIsolatePublicationSafety({
        identity: input.identity,
        safety: { ...safety, sequence: 1 },
      })
    ).toBe('stale');
    await expect(
      recordIsolatePublicationSafety({
        identity: input.identity,
        safety: { ...safety, publication: 'pending' },
      })
    ).rejects.toThrow('Conflicting');
    await expect(
      recordIsolatePublicationSafety({
        identity: input.identity,
        safety: { ...safety, sequence: 3, publication: 'not_started' },
      })
    ).rejects.toThrow('regresses');
    await expect(
      recordIsolatePublicationSafety({
        identity: { ...input.identity, executionUserId: 'other' },
        safety,
      })
    ).rejects.toThrow('identity mismatch');
    await updateCodeReviewStatus(input.identity.reviewId, 'cancelled');
    const successor = await candidate({
      repo: input.identity.target.repoFullName,
      head: 'd'.repeat(40),
    });
    await recordIsolatePublicationSafety({
      identity: input.identity,
      safety: { ...safety, sequence: 3, publication: 'settled', quiescent: true },
    });
    const [unchanged] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, successor.identity.reviewId));
    expect(unchanged.status).toBe('queued');
    expect(unchanged.head_sha).toBe('d'.repeat(40));
  });
});
