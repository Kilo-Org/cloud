import {
  getPrObservationSummary,
  normalizePrObservationEvent,
  PR_OBSERVATION_LIMIT,
  reducePrObservation,
  type PrObservationEvent,
} from './pr-observations';

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
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
      checks: { total: 2, failed: 1 },
      unresolvedThreads: null,
      truncated: false,
    });
  });
  it.each(['success', 'neutral', 'skipped'])('does not count %s as a failure', conclusion => {
    expect(
      getPrObservationSummary(apply(null, check(1, 'test', 1, conclusion)), head)?.checks
    ).toEqual({ total: 1, failed: 0 });
  });
  it('deduplicates repeated deliveries and rejects stale reruns', () => {
    const event = check(2, 'test', 1, 'success');
    const state = apply(null, event);
    expect(apply(state, event)).toEqual(state);
    expect(apply(state, check())).toEqual(state);
  });
  it('allows a new same-run attempt to supersede an old failure', () => {
    const completed = check();
    if (completed?.kind !== 'check') throw new Error('Expected check');
    const rerun = {
      ...completed,
      check: { ...completed.check, attempt: 2, phase: 0, at: null, failed: false },
    };
    const state = apply(apply(null, completed), rerun);
    expect(getPrObservationSummary(apply(state, completed), head)?.checks).toEqual({
      total: 1,
      failed: 0,
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
    ).toEqual({ total: 1, failed: 0 });
  });
  it('hides previous-commit counts and ignores stale-SHA deliveries', () => {
    const state = apply(null, check());
    expect(getPrObservationSummary(state, oldHead)).toBeNull();
    expect(apply(state, check(2, 'test', 1, 'success', oldHead))).toEqual(state);
    expect(apply(null, check(2, 'test', 1, 'success', oldHead))).toBeNull();
    const pushed = apply(state, check(2, 'new', 1, 'success', oldHead), oldHead);
    expect(getPrObservationSummary(pushed, oldHead)?.checks).toEqual({ total: 1, failed: 0 });
  });
  it('counts root threads, not replies, and preserves threads across commits', () => {
    const state = apply(null, comment());
    expect(comment(101, 'created', 100)).toBeNull();
    expect(comment(100, 'edited')).toBeNull();
    expect(getPrObservationSummary(state, oldHead)).toEqual({
      checks: null,
      unresolvedThreads: 1,
      truncated: false,
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
  ])('does not guess ordering for %s followed by %s', (first, second) => {
    const state = apply(apply(null, thread(first)), thread(second));
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: null,
      unresolvedThreads: null,
      truncated: true,
    });
    expect(
      getPrObservationSummary(apply(state, thread(second)), head)?.unresolvedThreads
    ).toBeNull();
  });
  it('does not infer that deleting a root removed its replies and thread', () => {
    const state = apply(apply(null, comment()), comment(100, 'deleted'));
    expect(getPrObservationSummary(state, head)?.unresolvedThreads).toBeNull();
    expect(getPrObservationSummary(apply(state, comment()), head)?.unresolvedThreads).toBeNull();
  });
  it('keeps unmappable thread state unknown', () => {
    expect(
      getPrObservationSummary(apply(apply(null, thread('resolved', [])), comment()), head)
    ).toEqual({ checks: null, unresolvedThreads: null, truncated: true });
  });
  it('bounds check evidence and reports partial counts', () => {
    let state = apply(null, check());
    for (let index = 1; index <= PR_OBSERVATION_LIMIT; index++)
      state = apply(state, check(index + 1, `test-${index}`));
    expect(state?.checks).toHaveLength(PR_OBSERVATION_LIMIT);
    expect(getPrObservationSummary(state, head)).toEqual({
      checks: { total: PR_OBSERVATION_LIMIT, failed: PR_OBSERVATION_LIMIT },
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
