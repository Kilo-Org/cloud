import { watchPrMaintenancePolicySchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  emptyWatchPrProjection,
  normalizeWatchPrEvent,
  projectWatchPrEvent,
  watchPrContentFingerprint,
  watchPrProjectionSchema,
  type WatchPrEvent,
  type WatchPrObservationState,
} from './watch-pr-events';
import {
  collectWatchPrProblems,
  deriveWatchPrObservationExecutionStatus,
  watchPrBatchSchedule,
} from './watch-pr-observation';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  nextBase = 'c'.repeat(40);
const now = new Date('2026-11-12T12:00:00.000Z');
const policy = watchPrMaintenancePolicySchema.parse({
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'test/model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
});
function watch(): WatchPrObservationState {
  return {
    installation_id: '123',
    repository_id: '456',
    pr_number: 7,
    head_ref: 'feature',
    base_ref: 'main',
    head_sha: head,
    base_sha: base,
    status: 'watching',
    generation: 1,
    pending_revision: 0,
    projection: emptyWatchPrProjection(),
    lifecycle_reason: null,
    policy,
  };
}
function feedback(
  overrides: Partial<Extract<WatchPrEvent, { kind: 'feedback' }>> = {}
): Extract<WatchPrEvent, { kind: 'feedback' }> {
  return {
    kind: 'feedback',
    installationId: '123',
    repositoryId: '456',
    prNumber: 7,
    key: 'comment:9',
    action: 'created',
    updatedAt: now.toISOString(),
    sha: head,
    actorId: '8',
    actorLogin: 'reviewer',
    actorType: 'User',
    authorAssociation: 'OWNER',
    body: 'Handle the empty list.',
    state: 'commented',
    source: 'review_comment',
    sourceId: '9',
    rootId: '9',
    ...overrides,
  };
}
const project = (state: WatchPrObservationState, event: WatchPrEvent) =>
  projectWatchPrEvent(state, event, state.generation);

describe('maintenance observation contract', () => {
  it('never treats a configured human login as a bot trust bypass', () => {
    const current = watch();
    current.policy = { ...policy, trustedBotLogins: ['configured-reviewer'] };
    expect(
      collectWatchPrProblems(
        project(
          current,
          feedback({
            actorLogin: 'configured-reviewer',
            actorType: 'User',
            authorAssociation: 'NONE',
          })
        )
      )
    ).toEqual([]);
    expect(
      collectWatchPrProblems(
        project(
          current,
          feedback({
            actorLogin: 'configured-reviewer',
            actorType: 'User',
            authorAssociation: 'MEMBER',
          })
        )
      )
    ).toHaveLength(1);
    expect(
      collectWatchPrProblems(
        project(
          current,
          feedback({
            actorLogin: 'configured-reviewer',
            actorType: 'Bot',
            authorAssociation: 'NONE',
          })
        )
      )
    ).toHaveLength(1);
  });
  it('derives no-live execution state without treating pending or unknown checks as passing', () => {
    const current = watch();
    const event = {
      kind: 'check' as const,
      installationId: '123',
      repositoryId: '456',
      prNumbers: [7],
      key: `check:1:run:9:tests:${head}`,
      name: 'tests',
      objectId: '9',
      sha: head,
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      attempt: 1,
      state: 'in_progress',
      conclusion: null,
    };
    const pending = project(current, event);
    expect(deriveWatchPrObservationExecutionStatus(pending)).toBe('waiting_for_checks');
    const unknown = project(pending, {
      ...event,
      state: 'completed',
      updatedAt: '2026-11-12T12:01:00Z',
    });
    expect(deriveWatchPrObservationExecutionStatus(unknown)).toBe('waiting_for_checks');
    const passed = project(unknown, {
      ...event,
      state: 'completed',
      conclusion: 'success',
      updatedAt: '2026-11-12T12:02:00Z',
    });
    expect(deriveWatchPrObservationExecutionStatus({ ...passed, execution_status: 'fixing' })).toBe(
      'watching'
    );
    expect(
      deriveWatchPrObservationExecutionStatus({
        ...passed,
        lifecycle_reason: 'maintenance_verification_unavailable',
      })
    ).toBe('needs_input');
    expect(
      deriveWatchPrObservationExecutionStatus({
        ...passed,
        execution_status: 'waiting_for_session',
      })
    ).toBe('watching');
    expect(
      deriveWatchPrObservationExecutionStatus({
        ...project(current, feedback()),
        execution_status: 'waiting_for_session',
      })
    ).toBe('waiting_for_session');
  });
  it('keeps the same failing-check problem across jobs, reruns, and heads', () => {
    const event = {
      kind: 'check' as const,
      installationId: '123',
      repositoryId: '456',
      prNumbers: [7],
      key: `check:1:suite:2:tests:${head}`,
      name: 'tests',
      objectId: '10',
      sha: head,
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      attempt: 1,
      state: 'completed',
      conclusion: 'failure',
    };
    const first = collectWatchPrProblems(project(watch(), event))[0];
    const second = collectWatchPrProblems(
      project(watch(), {
        ...event,
        key: `check:1:suite:3:tests:${head}`,
        objectId: '11',
        attempt: 2,
      })
    )[0];
    expect(first?.problemKey).toBe(second?.problemKey);
    expect(first?.contentFingerprint).not.toBe(second?.contentFingerprint);
    const grouped = collectWatchPrProblems(
      project(project(watch(), event), {
        ...event,
        key: `check:1:suite:3:tests:${head}`,
        objectId: '11',
      })
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      logUnavailableReason: expect.stringContaining('Another failing job'),
    });
  });
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'accepts %s feedback without a GitHub trust lookup',
    authorAssociation => {
      const result = project(watch(), feedback({ authorAssociation }));
      expect(collectWatchPrProblems(result)).toMatchObject([
        { kind: 'review', sourceId: '9', body: 'Handle the empty list.' },
      ]);
      expect(watchPrProjectionSchema.parse(result.projection).pending).toEqual([
        { key: 'comment:9', reason: 'actionable_review' },
      ]);
    }
  );
  it.each(['kiloconnect[bot]', 'kiloconnect-lite[bot]', 'kiloconnect-development[bot]'])(
    'accepts %s reviewer feedback but not maintenance replies',
    actorLogin => {
      const current = watch();
      const reviewer = feedback({ actorLogin, actorType: 'Bot', authorAssociation: 'NONE' });
      expect(collectWatchPrProblems(project(current, reviewer))).toHaveLength(1);
      expect(project(current, { ...reviewer, body: 'Done. <!-- kilo-pr-maintenance -->' })).toBe(
        current
      );
      expect(
        collectWatchPrProblems(
          project(current, feedback({ body: 'Handle this <!-- kilo-pr-maintenance -->' }))
        )
      ).toHaveLength(1);
    }
  );
  it('ignores untrusted bots and outsiders, and accepts explicitly configured reviewers', () => {
    for (const reviewer of [
      feedback({ authorAssociation: 'CONTRIBUTOR' }),
      feedback({ actorType: 'Bot', actorLogin: 'coverage[bot]' }),
    ]) {
      expect(collectWatchPrProblems(project(watch(), reviewer))).toEqual([]);
    }
    const current = watch();
    current.policy = { ...policy, trustedBotLogins: ['review-helper[bot]'] };
    expect(
      collectWatchPrProblems(
        project(
          current,
          feedback({
            actorType: 'Bot',
            actorLogin: 'review-helper[bot]',
            authorAssociation: 'NONE',
          })
        )
      )
    ).toHaveLength(1);
  });
  it('does not let untrusted bot traffic fill the projection or schedule work', () => {
    const current = watch();
    const ignored = project(
      current,
      feedback({ actorType: 'Bot', actorLogin: 'coverage[bot]', authorAssociation: 'NONE' })
    );
    expect(ignored).toBe(current);
    expect(watchPrBatchSchedule(current, ignored, now)).toEqual({
      pending_since: null,
      next_run_at: null,
    });
  });
  it('removes known feedback even when its deleted author no longer has a trusted association', () => {
    const first = project(watch(), feedback());
    const removed = project(
      first,
      feedback({ action: 'deleted', authorAssociation: 'NONE', updatedAt: '2026-11-12T12:01:00Z' })
    );
    expect(collectWatchPrProblems(removed)).toEqual([]);
  });
  it('accepts deletion without a changed producer timestamp and never resurrects the comment', () => {
    const first = project(watch(), feedback());
    const removed = project(first, feedback({ action: 'deleted' }));
    expect(collectWatchPrProblems(removed)).toEqual([]);
    expect(project(removed, feedback())).toBe(removed);
  });
  it('suppresses durable reply IDs without suppressing the same bot account', () => {
    const current = watch();
    expect(projectWatchPrEvent(current, feedback(), 1, [], ['comment:9'])).toBe(current);
    expect(projectWatchPrEvent(current, feedback(), 1, [], ['issue_comment:9'])).not.toBe(current);
    expect(
      projectWatchPrEvent(
        current,
        feedback({ key: 'review:9', source: 'review' }),
        1,
        [],
        ['comment:9']
      )
    ).not.toBe(current);
  });
  it.each([
    'The marker `<!-- kilo-pr-maintenance -->` needs validation.',
    'Keep this literal:\n```html\n<!-- kilo-pr-maintenance -->\n```',
  ])('does not suppress Kilo findings that quote the reply marker as code', body => {
    expect(
      collectWatchPrProblems(
        project(
          watch(),
          feedback({
            actorLogin: 'kiloconnect[bot]',
            actorType: 'Bot',
            authorAssociation: 'NONE',
            body,
          })
        )
      )
    ).toHaveLength(1);
  });
  it('only advances the batch revision when actionable edited content changes', () => {
    const first = project(watch(), feedback());
    const metadataEdit = project(
      first,
      feedback({
        action: 'edited',
        updatedAt: '2026-11-12T12:01:00Z',
        body: 'Handle  the empty list.\n<!-- generated:2 -->',
      })
    );
    expect(metadataEdit.pending_revision).toBe(first.pending_revision);
    const changed = project(
      metadataEdit,
      feedback({
        action: 'edited',
        updatedAt: '2026-11-12T12:02:00Z',
        body: 'Also handle a missing list.',
      })
    );
    expect(changed.pending_revision).toBe(first.pending_revision + 1);
    expect(
      project(changed, feedback({ action: 'edited', updatedAt: '2026-11-12T12:01:00Z' }))
    ).toBe(changed);
    expect(watchPrContentFingerprint('Fix this <!-- metadata -->')).toBe(
      watchPrContentFingerprint('Fix this')
    );
    expect(watchPrContentFingerprint('Use `a b`')).not.toBe(
      watchPrContentFingerprint('Use `a  b`')
    );
    expect(watchPrContentFingerprint('Fix <!-- generated `id` --> this')).toBe(
      watchPrContentFingerprint('Fix this')
    );
    expect(watchPrContentFingerprint('```ts\nconst x = "a b";\n```')).not.toBe(
      watchPrContentFingerprint('```ts\nconst x = "a  b";\n```')
    );
  });
  it('retains old unresolved feedback across head updates and removes resolved threads', () => {
    const first = project(watch(), feedback({ threadId: 'thread-1' }));
    const newer = project(first, {
      kind: 'push',
      installationId: '123',
      repositoryId: '456',
      ref: 'feature',
      before: head,
      after: 'd'.repeat(40),
      deleted: false,
    });
    expect(collectWatchPrProblems(newer)).toHaveLength(1);
    const resolved = project(newer, {
      kind: 'thread',
      installationId: '123',
      repositoryId: '456',
      prNumber: 7,
      threadId: 'thread-1',
      rootIds: ['9'],
      resolved: true,
      updatedAt: '2026-11-12T12:02:00Z',
    });
    expect(collectWatchPrProblems(resolved)).toEqual([]);
    expect(
      project(resolved, {
        kind: 'thread',
        installationId: '123',
        repositoryId: '456',
        prNumber: 7,
        threadId: 'thread-1',
        rootIds: ['9'],
        resolved: false,
        updatedAt: '2026-11-12T12:01:00Z',
      })
    ).toBe(resolved);
  });
  it('does not turn reordered thread transitions without timestamps into a repair', () => {
    let state = project(watch(), feedback({ threadId: 'thread-1' }));
    const event = {
      kind: 'thread' as const,
      installationId: '123',
      repositoryId: '456',
      prNumber: 7,
      threadId: 'thread-1',
      rootIds: ['9'],
      updatedAt: null,
    };
    state = project(state, { ...event, resolved: true });
    state = project(state, { ...event, resolved: false });
    expect(watchPrProjectionSchema.parse(state.projection).ambiguous).toBe(true);
    expect(collectWatchPrProblems(state)).toEqual([]);
  });
  it('normalizes PR conversation comments but ignores ordinary issue comments', () => {
    const payload = {
      installation: { id: 123 },
      repository: { id: 456 },
      action: 'created',
      issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/test/repo/pulls/7' } },
      comment: {
        id: 9,
        body: 'Please handle empty lists.',
        user: { id: 8, login: 'reviewer', type: 'User' },
        author_association: 'MEMBER',
        updated_at: now.toISOString(),
      },
    };
    const event = normalizeWatchPrEvent('issue_comment', payload);
    expect(event?.kind).toBe('feedback');
    if (!event) throw new Error('Expected a PR comment');
    expect(collectWatchPrProblems(project(watch(), event))).toMatchObject([
      { source: 'conversation_comment', threadId: null, commitSha: null },
    ]);
    expect(normalizeWatchPrEvent('issue_comment', { ...payload, issue: { number: 7 } })).toBeNull();
  });
  it('skips conflict calls for a base push with no file overlap and never queues a base-only repair', () => {
    const current = watch();
    const projection = emptyWatchPrProjection();
    projection.files = { headSha: head, paths: ['src/feature.ts'], complete: true };
    current.projection = projection;
    const updated = project(current, {
      kind: 'push',
      installationId: '123',
      repositoryId: '456',
      ref: 'main',
      before: base,
      after: nextBase,
      deleted: false,
      changedFiles: ['docs/readme.md'],
      filesComplete: true,
    });
    expect(watchPrProjectionSchema.parse(updated.projection)).toMatchObject({
      pending: [],
      conflict: { state: 'UNKNOWN', dueAt: null },
    });
    expect(collectWatchPrProblems(updated)).toEqual([]);
    expect(watchPrBatchSchedule(current, updated, now)).toEqual({
      pending_since: null,
      next_run_at: null,
    });
  });
  it('never fabricates a conflict problem without current-head CONFLICTING evidence', () => {
    const current = watch();
    current.projection = {
      ...emptyWatchPrProjection(),
      pending: [{ key: 'conflict', reason: 'conflict' }],
    };
    expect(collectWatchPrProblems(current)).toEqual([]);
  });
  it('bounds event batching by the first event and preserves production timestamp shapes', () => {
    const first = project(watch(), feedback());
    const initial = watchPrBatchSchedule(watch(), first, now);
    expect(initial).toEqual({
      pending_since: now.toISOString(),
      next_run_at: '2026-11-12T12:00:30.000Z',
    });
    const current = {
      ...first,
      pending_since: '2026-11-12 12:00:00+00',
      next_run_at: initial.next_run_at,
    };
    const next = project(
      current,
      feedback({ body: 'Handle another case.', updatedAt: '2026-11-12T12:01:50Z' })
    );
    expect(watchPrBatchSchedule(current, next, new Date('2026-11-12T12:01:50Z')).next_run_at).toBe(
      '2026-11-12T12:02:00.000Z'
    );
    expect(watchPrBatchSchedule(current, { ...next, status: 'paused' }, now)).toEqual({
      pending_since: null,
      next_run_at: null,
    });
  });
});
