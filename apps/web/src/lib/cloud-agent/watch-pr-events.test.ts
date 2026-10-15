import {
  emptyWatchPrProjection,
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  watchPrEventMatches,
  watchPrProjectionSchema,
  type WatchPrEvent,
  type WatchPrObservationState,
} from './watch-pr-events';

const head = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const base = 'c'.repeat(40);
const later = '2026-10-14T12:01:00Z';
const earlier = '2026-10-14T12:00:00Z';
const envelope = { installation: { id: 123 }, repository: { id: 456 } };
const identity = { installationId: '123', repositoryId: '456' };

function watch(overrides: Partial<WatchPrObservationState> = {}): WatchPrObservationState {
  return {
    installation_id: '123',
    repository_id: '456',
    pr_number: 42,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: head,
    base_sha: base,
    status: 'watching',
    generation: 1,
    pending_revision: 0,
    projection: emptyWatchPrProjection(),
    lifecycle_reason: null,
    ...overrides,
  };
}
function check(overrides: Partial<Extract<WatchPrEvent, { kind: 'check' }>> = {}): WatchPrEvent {
  return {
    ...identity,
    kind: 'check',
    prNumbers: [],
    key: `check:7:suite:8:tests:${head}`,
    objectId: '10',
    sha: head,
    updatedAt: later,
    startedAt: earlier,
    attempt: 1,
    state: 'completed',
    conclusion: 'failure',
    ...overrides,
  };
}
function feedback(
  overrides: Partial<Extract<WatchPrEvent, { kind: 'feedback' }>> = {}
): WatchPrEvent {
  return {
    ...identity,
    kind: 'feedback',
    prNumber: 42,
    key: 'comment:9',
    action: 'created',
    updatedAt: earlier,
    sha: head,
    actorId: '99',
    body: 'Please fix this',
    state: 'commented',
    ...overrides,
  };
}
function pr(
  overrides: Partial<Extract<WatchPrEvent, { kind: 'pull_request' }>> = {}
): WatchPrEvent {
  return {
    ...identity,
    kind: 'pull_request',
    prNumber: 42,
    action: 'synchronize',
    updatedAt: later,
    headSha: newer,
    baseSha: base,
    headRef: 'feature',
    baseRef: 'main',
    headRepositoryId: '456',
    baseRepositoryId: '456',
    closed: false,
    merged: false,
    ...overrides,
  };
}
function project(state: WatchPrObservationState, event: WatchPrEvent) {
  return projectWatchPrEvent(state, event, state.generation);
}
function projection(state: WatchPrObservationState) {
  return watchPrProjectionSchema.parse(state.projection);
}

describe('watch PR payload normalization', () => {
  it('validates full PR head/base repository identity', () => {
    const payload = {
      ...envelope,
      action: 'synchronize',
      pull_request: {
        number: 42,
        state: 'open',
        updated_at: later,
        head: { ref: 'feature', sha: newer, repo: { id: 456 } },
        base: { ref: 'main', sha: base, repo: { id: 456 } },
      },
    };
    expect(normalizeWatchPrEvent('pull_request', payload)).toMatchObject({
      ...identity,
      headRepositoryId: '456',
      headSha: newer,
    });
    expect(
      normalizeWatchPrEvent('pull_request', { ...payload, repository: { id: 'not-an-id' } })
    ).toBeNull();
  });

  it('bounds comment bodies and does not trust author association', () => {
    const event = normalizeWatchPrEvent('pull_request_review_comment', {
      ...envelope,
      action: 'edited',
      pull_request: { number: 42, head: { sha: newer } },
      comment: {
        id: 9,
        body: 'x'.repeat(10000),
        updated_at: earlier,
        commit_id: head,
        user: { id: 99 },
        author_association: 'OWNER',
      },
    });
    expect(event?.kind).toBe('feedback');
    if (event?.kind !== 'feedback') throw new Error('missing feedback');
    expect(event.body).toHaveLength(4000);
    expect(event).not.toHaveProperty('author_association');
    expect(projection(project(watch(), event)).pending[0]?.reason).toBe(
      'reviewer_verification_required'
    );
  });

  it('keeps review edits without an update timestamp explicitly unordered', () => {
    const event = normalizeWatchPrEvent('pull_request_review', {
      ...envelope,
      action: 'edited',
      pull_request: { number: 42 },
      review: {
        id: 9,
        body: 'updated',
        user: { id: 99 },
        state: 'CHANGES_REQUESTED',
        commit_id: head,
        submitted_at: earlier,
      },
    });
    expect(event).toMatchObject({ kind: 'feedback', updatedAt: null, state: 'changes_requested' });
  });

  it('normalizes checks with empty PR associations without URLs or unbounded output', () => {
    expect(
      normalizeWatchPrEvent('check_run', {
        ...envelope,
        action: 'completed',
        check_run: {
          id: 10,
          head_sha: head,
          name: 'tests',
          app: { id: 7 },
          status: 'completed',
          conclusion: 'success',
          started_at: earlier,
          completed_at: later,
          pull_requests: [],
          details_url: 'https://untrusted.test',
          output: { text: 'x'.repeat(100000) },
        },
      })
    ).toEqual({
      ...identity,
      kind: 'check',
      prNumbers: [],
      key: `check:7:run:10:tests:${head}`,
      objectId: '10',
      sha: head,
      updatedAt: later,
      startedAt: earlier,
      attempt: 1,
      state: 'completed',
      conclusion: 'success',
    });
  });

  it('normalizes status contexts by immutable provider identity and rejects malformed SHA', () => {
    const payload = {
      ...envelope,
      id: 10,
      sha: head,
      context: 'CI',
      state: 'failure',
      updated_at: later,
      creator: { id: 7 },
    };
    expect(normalizeWatchPrEvent('status', payload)).toMatchObject({
      kind: 'status',
      key: `status:7:CI:${head}`,
    });
    expect(normalizeWatchPrEvent('status', { ...payload, sha: 'abc' })).toBeNull();
  });

  it.each([true, false])(
    'preserves same-name independent checks (suite supplied: %s)',
    withSuite => {
      const normalizeCheck = (runId: number, suiteId: number, conclusion: string) => {
        const event = normalizeWatchPrEvent('check_run', {
          ...envelope,
          action: 'completed',
          check_run: {
            id: runId,
            head_sha: head,
            name: 'tests',
            app: { id: 7 },
            ...(withSuite ? { check_suite: { id: suiteId } } : {}),
            status: 'completed',
            conclusion,
            started_at: runId === 10 ? earlier : later,
            completed_at: later,
          },
        });
        if (!event) throw new Error('missing check');
        return event;
      };
      const failure = normalizeCheck(10, 100, 'failure');
      const success = normalizeCheck(11, 200, 'success');
      const observed = project(project(watch(), failure), success);
      expect(projection(observed).evidence).toHaveLength(2);
      expect(projection(observed).pending).toEqual([
        {
          key: `check:7:${withSuite ? 'suite:100' : 'run:10'}:tests:${head}`,
          reason: 'failed_check',
        },
      ]);
      if (withSuite) {
        const rerun = project(project(watch(), failure), normalizeCheck(11, 100, 'success'));
        expect(projection(rerun).evidence).toHaveLength(1);
        expect(projection(rerun).pending).toEqual([]);
      }
    }
  );

  it('only normalizes branch pushes and supported event types', () => {
    const payload = {
      ...envelope,
      before: head,
      after: newer,
      deleted: false,
      forced: true,
      ref: 'refs/heads/feature',
    };
    expect(normalizeWatchPrEvent('push', payload)).toMatchObject({
      kind: 'push',
      ref: 'feature',
      before: head,
      after: newer,
    });
    expect(normalizeWatchPrEvent('push', { ...payload, ref: 'refs/tags/v1' })).toBeNull();
    expect(normalizeWatchPrEvent('issue_comment', payload)).toBeNull();
    expect(normalizeWatchPrEvent('status', null)).toBeNull();
  });
});

describe('watch PR observation projection', () => {
  it('routes exact installation/repository/PR or SHA/ref, including empty check associations', () => {
    expect(watchPrEventMatches(watch(), check())).toBe(true);
    expect(watchPrEventMatches(watch(), check({ sha: newer }))).toBe(true);
    expect(watchPrEventMatches(watch(), check({ sha: newer, prNumbers: [43] }))).toBe(false);
    expect(watchPrEventMatches(watch(), check({ sha: newer, prNumbers: [42] }))).toBe(true);
    expect(watchPrEventMatches(watch({ installation_id: '987' }), feedback())).toBe(false);
    expect(watchPrEventMatches(watch({ repository_id: '987' }), feedback())).toBe(false);
    expect(watchPrEventMatches(watch(), feedback({ prNumber: 43 }))).toBe(false);
    expect(
      watchPrEventMatches(watch(), {
        ...identity,
        kind: 'push',
        ref: 'other',
        before: base,
        after: newer,
        deleted: false,
      })
    ).toBe(false);
  });

  it('passing, pending and unknown checks produce no actionable observation', () => {
    for (const conclusion of ['success', 'neutral', 'skipped', 'cancelled', 'unknown', null]) {
      expect(projection(project(watch(), check({ conclusion }))).pending).toEqual([]);
    }
    expect(
      projection(project(watch(), check({ state: 'in_progress', conclusion: 'failure' }))).pending
    ).toEqual([]);
  });

  it('retains explicitly associated early failure and joins only when its head arrives', () => {
    const early = project(
      watch(),
      check({ sha: newer, key: `check:7:suite:8:tests:${newer}`, prNumbers: [42] })
    );
    expect(projection(early).pending).toEqual([]);
    const joined = project(early, pr());
    expect(projection(joined).pending).toEqual([
      { key: `check:7:suite:8:tests:${newer}`, reason: 'failed_check' },
    ]);
  });

  it('retains bounded needs-head checks and statuses without GitHub PR associations', () => {
    const earlyCheck = project(
      watch(),
      check({ sha: newer, key: `check:7:suite:8:tests:${newer}` })
    );
    const earlyStatus = project(earlyCheck, {
      ...identity,
      kind: 'status',
      key: `status:7:legacy:${newer}`,
      objectId: '12',
      sha: newer,
      updatedAt: later,
      state: 'failure',
    });
    expect(projection(earlyStatus).evidence).toHaveLength(2);
    expect(projection(earlyStatus).pending).toEqual([]);
    expect(projection(project(earlyStatus, pr())).pending).toEqual([
      { key: `check:7:suite:8:tests:${newer}`, reason: 'failed_check' },
      { key: `status:7:legacy:${newer}`, reason: 'failed_status' },
    ]);
  });

  it('old-head failures cannot produce actionable work or replace current head', () => {
    const current = project(watch(), pr());
    const stale = project(current, check({ prNumbers: [42] }));
    expect(stale.head_sha).toBe(newer);
    expect(projection(stale).pending).toEqual([]);
    const comment = project(stale, feedback());
    expect(comment.head_sha).toBe(newer);
    expect(projection(comment).pending).toEqual([
      { key: 'comment:9', reason: 'reviewer_verification_required' },
    ]);
  });

  it('preserves unresolved review feedback across head movement without retaining old-head failures', () => {
    const observed = project(project(watch(), feedback()), check());
    const moved = project(observed, pr());
    expect(projection(moved).pending).toEqual([
      { key: 'comment:9', reason: 'reviewer_verification_required' },
    ]);
    expect(projection(moved).needsAttention).toBe(true);
    const deleted = project(moved, feedback({ action: 'deleted', updatedAt: later }));
    expect(projection(deleted).pending).toEqual([]);
  });

  it('semantically identical deliveries do not increment pending revisions', () => {
    const first = project(watch(), check());
    const duplicate = project(first, check());
    expect(duplicate).toBe(first);
    expect(duplicate.pending_revision).toBe(1);
  });

  it('newer reruns within the same suite supersede failure and stale attempts cannot resurrect it', () => {
    const failed = project(watch(), check());
    const rerun = check({
      objectId: '11',
      startedAt: later,
      updatedAt: later,
      state: 'in_progress',
      conclusion: null,
    });
    const waiting = project(failed, rerun);
    expect(projection(waiting).pending).toEqual([]);
    expect(projection(project(waiting, check())).pending).toEqual([]);
    const passed = project(
      waiting,
      check({ objectId: '11', startedAt: later, conclusion: 'success' })
    );
    expect(projection(passed).pending).toEqual([]);
  });

  it('does not infer rerun supersession from a higher check ID without start-time proof', () => {
    const failed = project(watch(), check({ startedAt: null }));
    const uncertain = project(
      failed,
      check({ objectId: '11', startedAt: null, conclusion: 'success' })
    );
    expect(projection(uncertain)).toMatchObject({ ambiguous: true, needsAttention: true });
    expect(projection(uncertain).pending).toEqual(projection(failed).pending);
  });

  it('a higher attempt on the same run cannot be overwritten by the older attempt', () => {
    const current = project(watch(), check({ attempt: 2, conclusion: 'success' }));
    expect(project(current, check({ attempt: 1 }))).toBe(current);
  });

  it('orders same-ID reruns by their start time before their completed state', () => {
    const failed = project(watch(), check());
    const running = project(
      failed,
      check({ startedAt: later, updatedAt: later, state: 'in_progress', conclusion: null })
    );
    expect(projection(running).pending).toEqual([]);
    expect(project(running, check())).toBe(running);
    const passed = project(
      running,
      check({ startedAt: later, updatedAt: '2026-10-14T12:02:00Z', conclusion: 'success' })
    );
    expect(projection(passed).pending).toEqual([]);
    expect(project(passed, check())).toBe(passed);
  });

  it('does not guess whether an unversioned queued event is a rerun or a stale delivery', () => {
    const failed = project(watch(), check());
    const uncertain = project(
      failed,
      check({ state: 'queued', startedAt: null, updatedAt: null, conclusion: null })
    );
    expect(projection(uncertain)).toMatchObject({ ambiguous: true, needsAttention: true });
    expect(projection(uncertain).pending).toEqual(projection(failed).pending);
  });

  it('review edits/deletions supersede pending feedback and old revisions cannot revive it', () => {
    const first = project(watch(), feedback());
    const edited = project(
      first,
      feedback({ action: 'edited', updatedAt: later, body: 'new feedback' })
    );
    expect(edited.pending_revision).toBe(2);
    expect(projection(edited).evidence[0]?.body).toBe('new feedback');
    const deleted = project(
      edited,
      feedback({ action: 'deleted', updatedAt: '2026-10-14T12:02:00Z', body: 'new feedback' })
    );
    expect(projection(deleted).pending).toEqual([]);
    expect(project(deleted, feedback())).toBe(deleted);
  });

  it.each([false, true])(
    'retains ambiguity for same-time feedback deletion (delete first: %s)',
    deleteFirst => {
      const active = feedback({ updatedAt: later });
      const removed = feedback({ action: 'deleted', updatedAt: later });
      const first = project(watch(), deleteFirst ? removed : active);
      const uncertain = project(first, deleteFirst ? active : removed);
      expect(projection(uncertain)).toMatchObject({ ambiguous: true, needsAttention: true });
      expect(projection(uncertain).evidence).toEqual(projection(first).evidence);
    }
  );

  it('treats equivalent timestamps as equal rather than silently accepting conflicting revisions', () => {
    const first = project(watch(), feedback());
    const uncertain = project(
      first,
      feedback({ updatedAt: '2026-10-14T12:00:00+00:00', body: 'different' })
    );
    expect(projection(uncertain).ambiguous).toBe(true);
    expect(projection(uncertain).evidence[0]?.body).toBe('Please fix this');
  });

  it('marks unordered review edits ambiguous rather than trusting delivery order', () => {
    const current = project(watch(), feedback({ key: 'review:9' }));
    const uncertain = project(
      current,
      feedback({ key: 'review:9', action: 'edited', updatedAt: null, body: 'different' })
    );
    expect(projection(uncertain)).toMatchObject({ ambiguous: true, needsAttention: true });
    expect(projection(uncertain).evidence[0]?.body).toBe('Please fix this');
  });

  it('suppresses self feedback by immutable actor ID, not association', () => {
    const current = watch();
    expect(projectWatchPrEvent(current, feedback(), 1, ['99'])).toBe(current);
  });

  it('empty changes-requested reviews need human attention, not a fabricated fix', () => {
    expect(
      projection(project(watch(), feedback({ body: '', state: 'changes_requested' }))).pending[0]
        ?.reason
    ).toBe('review_blocker');
  });

  it('fences finished watches and stale generations, including reopened PR events', () => {
    const closed = project(watch(), pr({ closed: true, merged: true }));
    expect(closed).toMatchObject({
      status: 'finished',
      generation: 2,
      lifecycle_reason: 'pr_merged',
    });
    expect(project(closed, pr({ action: 'reopened', updatedAt: '2026-10-14T12:02:00Z' }))).toBe(
      closed
    );
    const current = watch({ generation: 2 });
    expect(projectWatchPrEvent(current, check(), 1)).toBe(current);
  });

  it('rejects old PR versions and preserves head after force push', () => {
    const moved = project(watch(), {
      ...identity,
      kind: 'push',
      ref: 'feature',
      before: head,
      after: newer,
      deleted: false,
    });
    const oldPr = project(moved, pr({ headSha: head, updatedAt: earlier }));
    expect(oldPr.head_sha).toBe(newer);
    expect(projection(oldPr).ambiguous).toBe(true);
    const confirmed = project(moved, pr());
    expect(projection(confirmed).headPushObserved).toBe(false);
    expect(project(confirmed, pr({ headSha: head, updatedAt: earlier }))).toBe(confirmed);
  });

  it('does not finish on a close snapshot contradicted by a newer head push', () => {
    const pushed = project(watch(), {
      ...identity,
      kind: 'push',
      ref: 'feature',
      before: head,
      after: newer,
      deleted: false,
    });
    const staleClosed = project(pushed, pr({ headSha: head, closed: true, action: 'closed' }));
    expect(staleClosed).toMatchObject({ status: 'watching', generation: 1, head_sha: newer });
    expect(projection(staleClosed)).toMatchObject({ ambiguous: true, needsAttention: true });
    const confirmed = project(staleClosed, pr({ closed: true, action: 'closed' }));
    expect(confirmed).toMatchObject({
      status: 'finished',
      lifecycle_reason: 'pr_closed',
      generation: 2,
    });
  });

  it('does not order conflicting PR heads or bases from equivalent timestamps', () => {
    const current = watch({ projection: emptyWatchPrProjection(later) });
    const uncertain = project(
      current,
      pr({ updatedAt: '2026-10-14T12:01:00+00:00', closed: true })
    );
    expect(uncertain).toMatchObject({ status: 'watching', head_sha: head });
    expect(projection(uncertain).ambiguous).toBe(true);
    const conflictingBase = project(current, pr({ headSha: head, baseSha: newer }));
    expect(conflictingBase.base_sha).toBe(base);
    expect(projection(conflictingBase).ambiguous).toBe(true);
  });

  it.each(['opened', 'reopened'])(
    'does not finish on a delayed equal-time close after %s with identical branch SHAs',
    action => {
      const open = project(watch(), pr({ action, headSha: head }));
      const delayed = project(
        open,
        pr({
          action: 'closed',
          closed: true,
          headSha: head,
          updatedAt: '2026-10-14T12:01:00+00:00',
        })
      );
      expect(delayed).toMatchObject({ status: 'watching', generation: 1 });
      expect(projection(delayed)).toMatchObject({
        ambiguous: true,
        needsAttention: true,
        prState: 'open',
      });
      const ordered = project(
        delayed,
        pr({ action: 'closed', closed: true, headSha: head, updatedAt: '2026-10-14T12:02:00Z' })
      );
      expect(ordered).toMatchObject({ status: 'finished', lifecycle_reason: 'pr_closed' });
      expect(projection(ordered).prState).toBe('closed');
    }
  );

  it('defaults missing lifecycle state in existing version-one projections', () => {
    const { prState: _prState, ...existing } = emptyWatchPrProjection();
    expect(watchPrProjectionSchema.parse(existing).prState).toBeNull();
  });

  it('keeps disconnected push order ambiguous rather than rolling the branch back', () => {
    const current = watch({ head_sha: newer });
    const stale = project(current, {
      ...identity,
      kind: 'push',
      ref: 'feature',
      before: base,
      after: head,
      deleted: false,
    });
    expect(stale.head_sha).toBe(newer);
    expect(projection(stale).ambiguous).toBe(true);
  });

  it('does not let an unrelated PR event roll back a newer observed base push', () => {
    const pushed = project(watch(), {
      ...identity,
      kind: 'push',
      ref: 'main',
      before: base,
      after: newer,
      deleted: false,
    });
    const stale = project(pushed, pr({ headSha: head, baseSha: base }));
    expect(stale.base_sha).toBe(newer);
    expect(projection(stale)).toMatchObject({ ambiguous: true, basePushObserved: true });
    expect(projection(stale).pending).toEqual([{ key: 'base', reason: 'base_changed' }]);
  });

  it('replaces old-ref base push provenance and its pending episode after an ordered retarget', () => {
    const pushed = project(watch(), {
      ...identity,
      kind: 'push',
      ref: 'main',
      before: base,
      after: newer,
      deleted: false,
    });
    const targetSha = 'd'.repeat(40);
    const retargeted = project(
      pushed,
      pr({ action: 'edited', headSha: head, baseRef: 'release', baseSha: targetSha })
    );
    expect(retargeted).toMatchObject({ base_ref: 'release', base_sha: targetSha });
    expect(projection(retargeted)).toMatchObject({ ambiguous: false, basePushObserved: false });
    expect(projection(retargeted).evidence).toEqual([
      { kind: 'base', key: 'base', sha: targetSha, updatedAt: later, state: 'changed' },
    ]);
    expect(projection(retargeted).pending).toEqual([{ key: 'base', reason: 'base_changed' }]);
    expect(
      project(retargeted, {
        ...identity,
        kind: 'push',
        ref: 'main',
        before: newer,
        after: head,
        deleted: false,
      })
    ).toBe(retargeted);
    const newBasePush = project(retargeted, {
      ...identity,
      kind: 'push',
      ref: 'release',
      before: targetSha,
      after: base,
      deleted: false,
    });
    expect(newBasePush.base_sha).toBe(base);
    expect(projection(newBasePush)).toMatchObject({ ambiguous: false, basePushObserved: true });
  });

  it('coalesces exact base-ref movement into one pending episode and pauses deleted branches', () => {
    const first = project(watch(), {
      ...identity,
      kind: 'push',
      ref: 'main',
      before: base,
      after: head,
      deleted: false,
    });
    const second = project(first, {
      ...identity,
      kind: 'push',
      ref: 'main',
      before: head,
      after: newer,
      deleted: false,
    });
    expect(projection(second).pending).toEqual([{ key: 'base', reason: 'base_changed' }]);
    expect(projection(second).evidence.filter(item => item.kind === 'base')).toHaveLength(1);
    expect(projection(second).ambiguous).toBe(false);
    const deleted = project(second, {
      ...identity,
      kind: 'push',
      ref: 'feature',
      before: head,
      after: '0'.repeat(40),
      deleted: true,
    });
    expect(deleted).toMatchObject({
      status: 'paused',
      generation: 2,
      lifecycle_reason: 'head_branch_deleted',
    });
  });

  it('projects all observation categories without repair preferences', () => {
    const failed = project(watch(), check());
    const reviewed = project(failed, feedback());
    const result = project(reviewed, {
      ...identity,
      kind: 'push',
      ref: 'main',
      before: base,
      after: newer,
      deleted: false,
    });
    expect(projection(result).evidence).toHaveLength(3);
    expect(projection(result).pending).toEqual([
      { key: `check:7:suite:8:tests:${head}`, reason: 'failed_check' },
      { key: 'comment:9', reason: 'reviewer_verification_required' },
      { key: 'base', reason: 'base_changed' },
    ]);
  });

  it('continues observations while paused without overwriting the user pause or generation', () => {
    const paused = watch({ status: 'paused', lifecycle_reason: 'user_paused', generation: 2 });
    const observed = project(paused, feedback());
    expect(observed).toMatchObject({
      status: 'paused',
      lifecycle_reason: 'user_paused',
      generation: 2,
    });
    expect(projection(observed).pending).toHaveLength(1);
    const deleted = project(observed, {
      ...identity,
      kind: 'push',
      ref: 'feature',
      before: head,
      after: '0'.repeat(40),
      deleted: true,
    });
    expect(deleted).toMatchObject({
      status: 'paused',
      lifecycle_reason: 'user_paused',
      generation: 2,
    });
    expect(projection(deleted).pending).toEqual(projection(observed).pending);
  });

  it('bounds retained evidence and explicitly reports incomplete coverage', () => {
    let state = watch();
    for (let i = 0; i < 101; i++) state = project(state, feedback({ key: `comment:${i}` }));
    expect(projection(state).evidence).toHaveLength(100);
    expect(projection(state)).toMatchObject({ truncated: true, needsAttention: true });
  });

  it('prioritizes unresolved feedback and current-head evidence over off-head check bursts', () => {
    let state = project(project(watch(), feedback()), check());
    for (let i = 0; i < 101; i++) {
      state = project(
        state,
        check({ key: `check:7:other-${i}:${newer}`, sha: newer, prNumbers: [42] })
      );
    }
    expect(projection(state).evidence).toHaveLength(100);
    expect(projection(state).pending).toEqual([
      { key: 'comment:9', reason: 'reviewer_verification_required' },
      { key: `check:7:suite:8:tests:${head}`, reason: 'failed_check' },
    ]);
    expect(projection(state)).toMatchObject({ truncated: true, needsAttention: true });
  });
});
