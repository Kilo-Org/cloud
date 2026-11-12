import {
  watchPrMaintenanceInputSchema,
  watchPrMaintenancePolicySchema,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  buildMaintenanceBrief,
  boundedMaintenanceInput,
  maintenanceStartAfter,
  selectMaintenanceProblems,
  verifiedMaintenanceResult,
} from './watch-pr-maintenance-decisions';

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
const problem = {
  kind: 'review' as const,
  problemKey: 'comment:1',
  contentFingerprint: 'feedback-v1',
  source: 'review_comment' as const,
  sourceId: '1',
  threadId: 'thread-1',
  authorLogin: 'reviewer',
  body: 'Handle the empty input.',
  url: null,
  commitSha: 'a'.repeat(40),
};
const snapshot = watchPrMaintenanceInputSchema.parse({
  version: 1,
  purpose: 'Validate widgets',
  constraints: ['Keep the public API stable'],
  repository: {
    repositoryId: '1',
    repoUrl: 'https://github.com/example/widgets',
    prNumber: 1,
    headRef: 'feature',
    baseRef: 'parent',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    parentCommitSha: null,
  },
  policy,
  ordinal: 1,
  problems: [problem],
  problemAttempts: [],
  priorDispositions: [],
  previousResults: [],
  verificationCommands: ['pnpm test'],
  references: [],
});

describe('maintenance start coordination', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  it.each(['busy', 'retry', 'question', 'permission'])(
    'waits for a %s user chat without reserving execution',
    status => {
      expect(
        maintenanceStartAfter([{ chat_kind: 'user', status, status_updated_at: null }], 180, now)
      ).toBe(now + 30_000);
    }
  );
  it('uses production-shaped status timestamps for the quiet period', () => {
    expect(
      maintenanceStartAfter(
        [{ chat_kind: 'user', status: 'idle', status_updated_at: '2026-11-12 11:59:00+00' }],
        180,
        now
      )
    ).toBe(now + 120_000);
  });
  it('ignores maintenance statuses and old user activity', () => {
    expect(
      maintenanceStartAfter(
        [
          {
            chat_kind: 'maintenance',
            status: 'question',
            status_updated_at: new Date(now).toISOString(),
          },
          { chat_kind: 'user', status: 'idle', status_updated_at: '2026-11-12 11:50:00+00' },
        ],
        180,
        now
      )
    ).toBeNull();
  });
});

describe('bounded repair context', () => {
  it('bounds a large batch without cutting individual feedback text', () => {
    const large = {
      ...snapshot,
      problems: Array.from({ length: 50 }, (_, index) => ({
        ...problem,
        problemKey: `comment:${index}`,
        body: 'x'.repeat(12_000),
      })),
    };
    const bounded = boundedMaintenanceInput(large);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(262_144);
    expect(bounded.problems.length).toBeLessThan(50);
    expect(
      bounded.problems.every(item => item.kind === 'review' && item.body.length === 12_000)
    ).toBe(true);
    expect(bounded.constraints).toEqual(snapshot.constraints);
  });
  it('gives changed unresolved fingerprints a fresh problem budget', () => {
    const selected = selectMaintenanceProblems({
      problems: [{ ...problem, contentFingerprint: 'edited' }],
      policy,
      headSha: snapshot.repository.headSha,
      attempts: [{ input: snapshot }, { input: snapshot }],
      dispositions: [],
    });
    expect(selected.exhausted).toBe(false);
    expect(selected.problems).toHaveLength(1);
  });
  it('exhausts only the same unresolved fingerprint without blocking another problem', () => {
    const selected = selectMaintenanceProblems({
      problems: [problem, { ...problem, problemKey: 'comment:2' }],
      policy,
      headSha: snapshot.repository.headSha,
      attempts: [{ input: snapshot }, { input: snapshot }],
      dispositions: [],
    });
    expect(selected.exhausted).toBe(true);
    expect(selected.problems.map(item => item.problemKey)).toEqual(['comment:2']);
  });
  it('retries a deferred conflict but preserves deferred review decisions', () => {
    const conflict = {
      kind: 'conflict' as const,
      problemKey: 'conflict',
      contentFingerprint: 'same-conflict',
      headSha: snapshot.repository.headSha,
      baseSha: snapshot.repository.baseSha,
    };
    expect(
      selectMaintenanceProblems({
        problems: [conflict],
        policy,
        headSha: snapshot.repository.headSha,
        attempts: [],
        dispositions: [
          {
            problem_key: 'conflict',
            content_fingerprint: 'same-conflict',
            disposition: 'deferred',
          },
        ],
      }).problems
    ).toEqual([conflict]);
  });
  it('reduces the problem batch before dropping prior decisions or verification history', () => {
    const prior = {
      problemKey: problem.problemKey,
      contentFingerprint: 'prior',
      disposition: 'disagreed' as const,
      reason: 'Preserve API compatibility',
      evidence: [],
      threadId: problem.threadId,
      reply: null,
      resolve: false,
    };
    const previous = {
      attemptId: '10000000-0000-4000-8000-000000000001',
      summary: 'Previous focused fix',
      verification: [
        { command: 'pnpm test', outcome: 'passed' as const, summary: 'Passed', evidenceUrls: [] },
      ],
      publication: { status: 'not_attempted' as const, reason: 'No code change' },
    };
    const bounded = boundedMaintenanceInput({
      ...snapshot,
      problems: Array.from({ length: 50 }, (_, index) => ({
        ...problem,
        problemKey: `comment:${index}`,
        body: 'x'.repeat(12_000),
      })),
      priorDispositions: [prior],
      previousResults: [previous],
    });
    expect(bounded.priorDispositions).toEqual([prior]);
    expect(bounded.previousResults).toEqual([previous]);
    expect(bounded.problems.length).toBeLessThan(50);
  });
  it('does not reconsider identical deferred feedback, but admits changed content', () => {
    const dispositions = [
      {
        problem_key: problem.problemKey,
        content_fingerprint: problem.contentFingerprint,
        disposition: 'deferred' as const,
      },
    ];
    const common = { policy, headSha: snapshot.repository.headSha, attempts: [], dispositions };
    expect(selectMaintenanceProblems({ ...common, problems: [problem] }).problems).toEqual([]);
    expect(
      selectMaintenanceProblems({
        ...common,
        problems: [{ ...problem, contentFingerprint: 'edited' }],
      }).problems
    ).toHaveLength(1);
  });
  it('rejects stale CI failures and does not rebase a normal PR without a conflict', () => {
    const stale = {
      kind: 'failed_check' as const,
      problemKey: 'check:1',
      contentFingerprint: 'failed',
      headSha: 'c'.repeat(40),
      checkId: '1',
      name: 'tests',
      detailsUrl: null,
      log: null,
      logUnavailableReason: null,
    };
    expect(
      selectMaintenanceProblems({
        problems: [stale],
        policy,
        headSha: snapshot.repository.headSha,
        attempts: [],
        dispositions: [],
      }).problems
    ).toEqual([]);
    const brief = buildMaintenanceBrief(snapshot);
    expect(brief).toContain("git rebase 'origin/parent'");
    expect(brief).toContain('Rebase only for an actual merge conflict');
    expect(brief).toContain('Do not use git add -A');
    expect(brief).toContain('Keep the public API stable');
    expect(brief).toContain('pnpm test');
  });
  it('gives a stacked PR the exact recorded parent boundary', () => {
    expect(
      buildMaintenanceBrief({
        ...snapshot,
        repository: { ...snapshot.repository, parentCommitSha: 'd'.repeat(40) },
      })
    ).toContain(`git rebase --onto 'origin/parent' ${'d'.repeat(40)}`);
  });
  it('makes the exact lease explanatory and disables rebases without conflict consent', () => {
    const brief = buildMaintenanceBrief({
      ...snapshot,
      policy: { ...policy, categories: { ...policy.categories, conflicts: false } },
    });
    expect(brief).toContain('Publication policy only, not a command to run');
    expect(brief).toContain('Do not push directly. Use only the runtime publication endpoint');
    expect(brief).toContain('Conflict repairs are disabled');
    expect(brief).not.toContain("git rebase 'origin/parent'");
  });
});

describe('runtime publication provenance', () => {
  const publication = {
    status: 'published',
    source: 'git',
    repoUrl: snapshot.repository.repoUrl,
    headRef: 'feature',
    observedHeadSha: 'a'.repeat(40),
    pushedHeadSha: 'c'.repeat(40),
    remoteHeadSha: 'c'.repeat(40),
    baseSha: 'b'.repeat(40),
    exactLease: `refs/heads/feature:${'a'.repeat(40)}`,
    pushExitCode: 0,
    verifiedAt: '2026-11-12T12:10:00Z',
  };
  const result = {
    version: 1,
    summary: 'Fixed the empty input',
    changedFiles: ['src/widget.ts'],
    verification: [
      { command: 'pnpm test', outcome: 'passed', summary: 'Passed', evidenceUrls: [] },
    ],
    publication,
    problems: [
      {
        problemKey: problem.problemKey,
        contentFingerprint: problem.contentFingerprint,
        disposition: 'addressed',
        reason: 'Input validation fixed',
        evidence: [],
        threadId: problem.threadId,
        reply: 'Fixed and tested.',
        resolve: true,
      },
    ],
    needsInput: null,
  };
  it('never accepts publication from agent prose or agent result alone', () => {
    const verified = verifiedMaintenanceResult({
      snapshot,
      result,
      publication: null,
      startedAt: '2026-11-12 12:00:00+00',
    });
    expect(verified?.publication.status).toBe('unknown');
    expect(verified?.problems[0]).toMatchObject({
      disposition: 'deferred',
      resolve: false,
      reply: null,
    });
  });
  it.each([
    { ...publication, repoUrl: 'https://github.com/example/other' },
    { ...publication, headRef: 'parent' },
    { ...publication, verifiedAt: '2026-11-11T12:00:00Z' },
    { ...publication, remoteHeadSha: 'd'.repeat(40) },
  ])('rejects mismatched or stale Git evidence', evidence => {
    expect(
      verifiedMaintenanceResult({
        snapshot,
        result,
        publication: evidence,
        startedAt: '2026-11-12T12:00:00Z',
      })?.publication.status
    ).toBe('unknown');
  });
  it('accepts exact-message runtime Git evidence and matching dispositions', () => {
    expect(
      verifiedMaintenanceResult({
        snapshot,
        result,
        publication,
        startedAt: '2026-11-12T12:00:00Z',
      })?.problems[0].resolve
    ).toBe(true);
  });
  it('keeps a published addressed disposition and a verification warning instead of suppressing it', () => {
    const verified = verifiedMaintenanceResult({
      snapshot,
      result: { ...result, verification: [] },
      publication,
      startedAt: '2026-11-12T12:00:00Z',
    });
    expect(verified?.problems[0]).toMatchObject({ disposition: 'addressed', resolve: false });
    expect(verified?.problems[0].reply).toContain('verification is incomplete');
  });
  it('turns a per-problem needs_input result into a live question', () => {
    const verified = verifiedMaintenanceResult({
      snapshot,
      result: {
        ...result,
        problems: [
          {
            ...result.problems[0],
            disposition: 'needs_input',
            resolve: false,
            reason: 'Choose the supported API behavior',
          },
        ],
      },
      publication,
      startedAt: '2026-11-12T12:00:00Z',
    });
    expect(verified?.needsInput).toBe('Choose the supported API behavior');
  });
  it('does not accept disposition identities outside the immutable attempt', () => {
    const modified = {
      ...result,
      problems: [{ ...result.problems[0], contentFingerprint: 'later-event' }],
    };
    expect(
      verifiedMaintenanceResult({
        snapshot,
        result: modified,
        publication,
        startedAt: '2026-11-12T12:00:00Z',
      })?.problems
    ).toEqual([]);
  });
});
