import {
  createEmptyPrObservations,
  getPrObservationSummary,
  normalizePrObservationEvent,
  PR_OBSERVATION_LIMIT,
  prMergeabilitySchema,
  reducePrObservation,
  type PrObservationEvent,
} from './pr-observations';

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const base = 'c'.repeat(40);
const at = '2026-10-21T12:00:00Z';
const later = '2026-10-21T12:01:00Z';
const envelope = { installation: { id: 10 }, repository: { id: 20, full_name: 'owner/repo' } };
function check(id = 1, name = 'test', appId = 1, conclusion = 'failure', sha = head) {
  return normalizePrObservationEvent('check_run', {
    ...envelope,
    action: 'completed',
    check_run: {
      id,
      app: { id: appId },
      name,
      head_sha: sha,
      status: 'completed',
      conclusion,
      started_at: at,
      completed_at: later,
    },
  });
}
function inProgressCheck(id = 1, name = 'test', appId = 1, startedAt = at) {
  return normalizePrObservationEvent('check_run', {
    ...envelope,
    check_run: {
      id,
      app: { id: appId },
      name,
      head_sha: head,
      status: 'in_progress',
      conclusion: null,
      started_at: startedAt,
      completed_at: null,
    },
  });
}
function comment(id = 100, action = 'created', inReplyTo?: number) {
  return normalizePrObservationEvent('pull_request_review_comment', {
    ...envelope,
    action,
    pull_request: { number: 7 },
    comment: { id, in_reply_to_id: inReplyTo },
  });
}
function thread(action = 'resolved', comments: unknown[] = [{ id: 100 }]) {
  return normalizePrObservationEvent('pull_request_review_thread', {
    ...envelope,
    action,
    pull_request: { number: 7 },
    thread: { node_id: 'PRRT_thread_900', comments },
  });
}
function apply(raw: unknown, event: PrObservationEvent | null, sha = head) {
  if (!event) throw new Error('Expected valid observation');
  return reducePrObservation(raw, sha, event);
}
function checkCounts(
  total: number,
  failed: number,
  passed = 0,
  pending = 0,
  skipped = 0,
  unknown = 0,
  complete = false
) {
  return { total, failed, passed, pending, skipped, unknown, complete };
}

describe('webhook-only PR observations', () => {
  it('keeps missing and invalid evidence unknown', () => {
    expect(getPrObservationSummary(null, head)).toBeNull();
    expect(getPrObservationSummary({}, head)).toBeNull();
    expect(normalizePrObservationEvent('check_run', envelope)).toBeNull();
    expect(normalizePrObservationEvent('issue_comment', envelope)).toBeNull();
  });
  it('counts app/name contexts rather than every rerun', () => {
    const state = apply(
      apply(apply(null, check()), check(2, 'test', 1, 'success')),
      check(3, 'test', 2)
    );
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: checkCounts(2, 1, 1),
      unresolvedThreads: null,
      truncated: false,
    });
  });
  it.each(['success', 'neutral', 'skipped'])('classifies the %s conclusion', conclusion => {
    expect(
      getPrObservationSummary(apply(null, check(1, 'test', 1, conclusion)), head)?.checks
    ).toMatchObject({ total: 1, failed: 0, passed: conclusion === 'success' ? 1 : 0 });
  });
  it('records richer outcomes so passes and pending runs are not inferred from "not failed"', () => {
    const state = apply(
      apply(apply(null, check(1, 'success', 1, 'success')), inProgressCheck(2, 'pending', 1)),
      inProgressCheck(3, 'running', 1)
    );
    const normalized = state?.checks.map(entry => entry.outcome);
    expect(normalized).toEqual(['passed', 'pending', 'pending']);
    expect(getPrObservationSummary(state, head)?.checks).toEqual(checkCounts(3, 0, 1, 2));
  });
  it('keeps legacy completed non-failed entries unknown rather than assuming they passed', () => {
    const legacy = {
      ...createEmptyPrObservations(),
      headSha: head,
      checks: [
        {
          key: 'check:1:test',
          id: '1',
          attempt: 1,
          at: later,
          phase: 2,
          failed: false,
        },
      ],
      checksTruncated: false,
    };
    expect(getPrObservationSummary(legacy, head)?.checks).toEqual(checkCounts(1, 0, 0, 0, 0, 1));
  });
  it('distinguishes a successful empty inventory from no observation at all', () => {
    const observed = {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: true,
      checksComplete: true,
    };
    expect(getPrObservationSummary(observed, head)).toEqual({
      checks: checkCounts(0, 0, 0, 0, 0, 0, true),
      unresolvedThreads: null,
      truncated: false,
    });

    const unknown = {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: false,
      checksComplete: false,
    };
    expect(getPrObservationSummary(unknown, head)).toBeNull();
  });
  it('does not report complete checks when the state was truncated at the cap', () => {
    const state = {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: true,
      checksComplete: true,
      checksTruncated: true,
    };
    expect(getPrObservationSummary(state, head)?.checks?.complete).toBe(false);
  });
  it('does not report complete checks when a check source is unavailable', () => {
    const state = {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: true,
      checksComplete: true,
      unavailable: ['statuses' as const],
    };
    expect(getPrObservationSummary(state, head)?.checks?.complete).toBe(false);
  });
  it('reports complete threads only without unknown, truncation, or review failure', () => {
    const baseState = {
      ...createEmptyPrObservations(),
      headSha: head,
      threadsObserved: true,
      threadsComplete: true,
    };
    expect(getPrObservationSummary(baseState, head)?.threadsComplete).toBe(true);
    expect(
      getPrObservationSummary({ ...baseState, threadsTruncated: true }, head)?.threadsComplete
    ).toBe(false);
    expect(
      getPrObservationSummary({ ...baseState, threadsUnknown: true }, head)?.threadsComplete
    ).toBe(false);
    expect(
      getPrObservationSummary({ ...baseState, unavailable: ['reviews' as const] }, head)
        ?.threadsComplete
    ).toBe(false);
    expect(
      getPrObservationSummary(
        {
          ...baseState,
          threads: [{ rootId: '1', threadId: null, state: 'unknown' as const }],
        },
        head
      )?.threadsComplete
    ).toBe(false);
  });
  it('summarizes mergeability even when no checks or threads were observed', () => {
    const state = {
      ...createEmptyPrObservations(),
      headSha: head,
      mergeability: {
        headSha: head,
        baseSha: base,
        baseRef: 'main',
        mergeable: true,
        state: 'clean',
        observedAt: at,
      },
    };
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: null,
      unresolvedThreads: null,
      truncated: false,
      mergeability: state.mergeability,
    });
    expect(getPrObservationSummary(state, oldHead)).toBeNull();
  });
  it('reports mergeability as null when the observed head no longer matches', () => {
    const state = apply(null, check(1, 'test', 1, 'success'));
    if (!state) throw new Error('Expected state');
    state.mergeability = {
      headSha: oldHead,
      baseSha: base,
      baseRef: 'main',
      mergeable: false,
      state: 'dirty',
      observedAt: at,
    };
    expect(getPrObservationSummary(state, head)?.mergeability).toBeNull();
  });
  it('preserves current-head mergeability when a check event establishes the state head', () => {
    const mergeability = {
      headSha: head,
      baseSha: base,
      baseRef: 'main',
      mergeable: true,
      state: 'clean',
      observedAt: at,
    };
    const state = apply(
      { ...createEmptyPrObservations(), headSha: null, mergeability },
      check(1, 'test', 1, 'success'),
      head
    );
    expect(state?.mergeability).toEqual(mergeability);
    expect(getPrObservationSummary(state, head)?.mergeability).toEqual(mergeability);
  });
  it('preserves current-head mergeability when the stored head is older', () => {
    const mergeability = {
      headSha: head,
      baseSha: base,
      baseRef: 'main',
      mergeable: true,
      state: 'clean',
      observedAt: at,
    };
    const state = apply(
      { ...createEmptyPrObservations(), headSha: oldHead, mergeability },
      check(1, 'test', 1, 'success'),
      head
    );
    expect(state?.mergeability).toEqual(mergeability);
    expect(getPrObservationSummary(state, head)?.mergeability).toEqual(mergeability);
  });
  it('still clears mergeability that belongs to a different head', () => {
    const state = apply(
      {
        ...createEmptyPrObservations(),
        headSha: null,
        mergeability: {
          headSha: oldHead,
          baseSha: base,
          baseRef: 'main',
          mergeable: true,
          state: 'clean',
          observedAt: at,
        },
      },
      check(1, 'test', 1, 'success'),
      head
    );
    expect(state?.mergeability).toBeUndefined();
  });
  it('validates mergeability metadata and normalizes SHAs', () => {
    expect(
      prMergeabilitySchema.parse({
        headSha: head.toUpperCase(),
        baseSha: base,
        baseRef: 'main',
        mergeable: null,
        state: null,
        observedAt: at,
      })
    ).toMatchObject({ headSha: head });
    expect(
      prMergeabilitySchema.safeParse({
        headSha: 'not-a-sha',
        baseSha: base,
        baseRef: 'main',
        mergeable: true,
        state: 'clean',
        observedAt: at,
      }).success
    ).toBe(false);
  });
  it('deduplicates repeated deliveries and rejects stale reruns', () => {
    const event = check(2, 'test', 1, 'success');
    const state = apply(null, event);
    expect(apply(state, event)).toEqual(state);
    expect(apply(state, check())).toEqual(state);
  });
  it('updates keyed inventory seeded by a fetch without accumulating previous results', () => {
    const hydrated = {
      ...createEmptyPrObservations(),
      headSha: head,
      checksObserved: true,
      checksComplete: true,
      checks: [
        {
          key: 'check:1:test',
          id: '5',
          attempt: 1,
          at,
          phase: 2,
          failed: false,
          outcome: 'passed' as const,
        },
      ],
    };
    const failure = apply(hydrated, check(6, 'test', 1, 'failure'));
    expect(failure?.checks).toHaveLength(1);
    expect(failure?.checks[0]).toMatchObject({ id: '6', outcome: 'failed' });
    expect(getPrObservationSummary(failure, head)?.checks).toEqual(
      checkCounts(1, 1, 0, 0, 0, 0, true)
    );

    const rerun = apply(failure, inProgressCheck(6, 'test', 1, '2026-10-21T12:02:00Z'));
    const rerunEvent = rerun?.checks[0];
    expect(rerunEvent).toMatchObject({ id: '6', attempt: 1, phase: 1, outcome: 'pending' });
    expect(apply(rerun, check(6, 'test', 1, 'failure'))).toEqual(rerun);
    expect(getPrObservationSummary(rerun, head)?.checks).toEqual(
      checkCounts(1, 0, 0, 1, 0, 0, true)
    );
  });
  it('allows a new same-run attempt to supersede an old failure', () => {
    const completed = check();
    if (completed?.kind !== 'check') throw new Error('Expected check');
    const rerun = {
      ...completed,
      check: {
        ...completed.check,
        attempt: 2,
        phase: 0,
        at: null,
        failed: false,
        outcome: 'pending' as const,
      },
    };
    const state = apply(apply(null, completed), rerun);
    expect(getPrObservationSummary(apply(state, completed), head)?.checks).toMatchObject({
      total: 1,
      failed: 0,
      pending: 1,
    });
  });
  it('never lets an older phase erase a completed failure', () => {
    const completed = check();
    if (completed?.kind !== 'check') throw new Error('Expected check');
    const state = apply(null, completed);
    expect(
      apply(state, { ...completed, check: { ...completed.check, at, phase: 0, failed: false } })
    ).toEqual(state);
  });
  it('orders legacy statuses by context and event id', () => {
    const status = (id: number, state: string) =>
      normalizePrObservationEvent('status', {
        ...envelope,
        id,
        sha: head,
        context: 'test',
        state,
        updated_at: at,
        creator: { id },
      });
    expect(
      getPrObservationSummary(apply(apply(null, status(2, 'success')), status(1, 'failure')), head)
        ?.checks
    ).toMatchObject({ total: 1, failed: 0, passed: 1 });
  });
  it('hides previous-commit counts and ignores stale-SHA deliveries', () => {
    const state = apply(null, check());
    expect(getPrObservationSummary(state, oldHead)).toBeNull();
    expect(apply(state, check(2, 'test', 1, 'success', oldHead))).toEqual(state);
    expect(apply(null, check(2, 'test', 1, 'success', oldHead))).toBeNull();
    const pushed = apply(state, check(2, 'new', 1, 'success', oldHead), oldHead);
    expect(getPrObservationSummary(pushed, oldHead)?.checks).toMatchObject({ total: 1, failed: 0 });
  });
  it('clears completion flags and mergeability when the head moves', () => {
    const seeded = {
      ...createEmptyPrObservations(),
      headSha: oldHead,
      checksObserved: true,
      checksComplete: true,
      mergeability: {
        headSha: oldHead,
        baseSha: base,
        baseRef: 'main',
        mergeable: true,
        state: 'clean',
        observedAt: at,
      },
    };
    const state = apply(seeded, check(2, 'new', 1, 'success', head), head);
    expect(state?.checksObserved).toBe(false);
    expect(state?.checksComplete).toBe(false);
    expect(state?.mergeability).toBeUndefined();
    expect(getPrObservationSummary(state, head)?.checks).toMatchObject({
      total: 1,
      complete: false,
    });
  });
  it('counts root threads, not replies, and preserves threads across commits', () => {
    const state = apply(null, comment());
    expect(comment(101, 'created', 100)).toBeNull();
    expect(comment(100, 'edited')).toBeNull();
    expect(getPrObservationSummary(state, oldHead)).toEqual({
      checks: null,
      unresolvedThreads: 1,
      truncated: false,
      threadsComplete: false,
    });
    expect(apply(state, comment())).toEqual(state);
  });
  it('reconciles real thread node IDs and never resurrects a resolved thread from delayed creation', () => {
    const resolved = apply(null, thread('resolved', [{ id: 101, in_reply_to_id: 100 }]));
    const state = apply(resolved, comment());
    expect(state?.threads).toHaveLength(1);
    expect(getPrObservationSummary(state, head)?.unresolvedThreads).toBe(0);
    expect(apply(apply(null, comment()), thread())).toEqual(state);
  });
  it.each([
    ['resolved', 'unresolved'],
    ['unresolved', 'resolved'],
  ])('applies the latest observed %s to %s transition', (first, second) => {
    const state = apply(apply(null, thread(first)), thread(second));
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: null,
      unresolvedThreads: second === 'resolved' ? 0 : 1,
      truncated: false,
      threadsComplete: false,
    });
    expect(getPrObservationSummary(apply(state, thread(second)), head)?.unresolvedThreads).toBe(
      second === 'resolved' ? 0 : 1
    );
  });
  it('updates repeated resolve/reopen cycles without extra threads or GitHub reads', () => {
    let state = apply(null, comment());
    for (const [action, count] of [
      ['resolved', 0],
      ['unresolved', 1],
      ['resolved', 0],
    ] as const) {
      state = apply(state, thread(action));
      expect(getPrObservationSummary(state, head)?.unresolvedThreads).toBe(count);
      const duplicate = apply(state, thread(action));
      expect(duplicate).toEqual(state);
      expect(duplicate?.threads).toHaveLength(1);
    }
  });
  it('recovers a previously uncertain mapped thread when a resolution webhook arrives', () => {
    const state = apply(
      {
        ...createEmptyPrObservations(),
        threadsObserved: true,
        threadsTruncated: true,
        threads: [{ rootId: '100', threadId: 'PRRT_thread_900', state: 'unknown' }],
      },
      thread('resolved')
    );
    expect(getPrObservationSummary(state, head)?.unresolvedThreads).toBe(0);
    expect(getPrObservationSummary(state, head)?.truncated).toBe(true);
  });
  it('does not infer that deleting a root removed its replies and thread', () => {
    const state = apply(apply(null, comment()), comment(100, 'deleted'));
    expect(getPrObservationSummary(state, head)?.unresolvedThreads).toBeNull();
    expect(getPrObservationSummary(apply(state, comment()), head)?.unresolvedThreads).toBeNull();
  });
  it('keeps unmappable thread state unknown', () => {
    expect(
      getPrObservationSummary(apply(apply(null, thread('resolved', [])), comment()), head)
    ).toEqual({
      checks: null,
      unresolvedThreads: null,
      truncated: true,
      threadsComplete: false,
    });
  });
  it('bounds check evidence and reports partial counts', () => {
    let state = apply(null, check());
    for (let index = 1; index <= PR_OBSERVATION_LIMIT; index++)
      state = apply(state, check(index + 1, `test-${index}`));
    expect(state?.checks).toHaveLength(PR_OBSERVATION_LIMIT);
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: checkCounts(PR_OBSERVATION_LIMIT, PR_OBSERVATION_LIMIT),
      unresolvedThreads: null,
      truncated: true,
    });
  });
  it('bounds thread evidence without discarding resolution tombstones', () => {
    let state = apply(null, thread());
    for (let index = 1; index <= PR_OBSERVATION_LIMIT; index++)
      state = apply(state, comment(100 + index));
    expect(state?.threads).toHaveLength(PR_OBSERVATION_LIMIT);
    expect(getPrObservationSummary(apply(state, comment()), head)?.truncated).toBe(true);
  });
});
