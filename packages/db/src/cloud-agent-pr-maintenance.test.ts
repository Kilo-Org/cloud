import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  hasWatchPrAutomaticWriteConsent,
  isLiveWatchPrAttempt,
  watchPrMaintenanceDefaults,
  watchPrMaintenanceInputSchema,
  watchPrMaintenancePolicySchema,
  watchPrMaintenanceResultSchema,
  watchPrPolicySchema,
  watchPrProblemResultSchema,
  watchPrPublicationEvidenceSchema,
} from './cloud-agent-pr-maintenance';
import {
  cli_sessions_v2,
  cloud_agent_pr_feedback_dispositions,
  cloud_agent_pr_maintenance_attempts,
} from './schema';

const policyInput = {
  version: 2,
  automaticWritesConsent: true,
  historyRewriteConsent: true,
  noHardSpendCapConsent: true,
  model: 'kilo/test-maintenance-model',
  profileId: null,
  environmentId: null,
  categories: { reviews: true, failedChecks: true, conflicts: true },
};
const legacyPolicy = {
  version: 1,
  model: 'kilo/test-maintenance-model',
  profileId: null,
  categories: { reviews: true, failedChecks: true, baseUpdates: true },
  branchStrategy: 'rebase',
  historyRewriteConsent: true,
  maxAttemptsPerProblem: 2,
  maxTotalAttempts: 10,
  observationOnlyConsent: true,
  futureEventsOnlyConsent: true,
  noHardSpendCapConsent: true,
};
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const publishedSha = 'c'.repeat(40);
const problem = {
  kind: 'conflict',
  problemKey: 'conflict:synthetic-head',
  contentFingerprint: 'synthetic-conflict-revision',
  headSha,
  baseSha,
};

function input() {
  return {
    version: 1,
    purpose: 'Repair this synthetic PR.',
    constraints: ['Do not merge the PR.'],
    repository: {
      repositoryId: '123',
      repoUrl: 'https://github.com/example/maintenance',
      prNumber: 1,
      headRef: 'feature/repair',
      baseRef: 'main',
      headSha,
      baseSha,
      parentCommitSha: null,
    },
    policy: policyInput,
    ordinal: 1,
    problems: [problem],
    problemAttempts: [{ problemKey: problem.problemKey, attempts: 0 }],
    priorDispositions: [],
    previousResults: [],
    verificationCommands: ['pnpm test'],
    references: [],
  };
}

describe('PR maintenance contracts', () => {
  it('keeps legacy observation consent separate from automatic write consent', () => {
    const parsed = watchPrPolicySchema.parse(legacyPolicy);
    expect(parsed).toEqual(legacyPolicy);
    expect(hasWatchPrAutomaticWriteConsent(parsed)).toBe(false);
    expect(watchPrMaintenancePolicySchema.safeParse(legacyPolicy).success).toBe(false);
    expect(
      watchPrPolicySchema.safeParse({ ...legacyPolicy, automaticWritesConsent: true }).success
    ).toBe(false);
  });

  it.each(['automaticWritesConsent', 'historyRewriteConsent', 'noHardSpendCapConsent'])(
    'requires fresh explicit %s',
    consent => {
      const withoutConsent: Record<string, unknown> = { ...policyInput };
      delete withoutConsent[consent];
      expect(watchPrMaintenancePolicySchema.safeParse(withoutConsent).success).toBe(false);
      expect(
        watchPrMaintenancePolicySchema.safeParse({ ...policyInput, [consent]: false }).success
      ).toBe(false);
    }
  );

  it('uses bounded pilot defaults and records execution settings', () => {
    const policy = watchPrMaintenancePolicySchema.parse({
      ...policyInput,
      model: 'kilo/test-maintenance-model',
      variant: 'test-high',
      trustedBotLogins: ['EXAMPLE-REVIEW[bot]'],
    });
    expect(policy).toMatchObject({
      variant: 'test-high',
      branchStrategy: 'rebase',
      maxAttemptsPerProblem: 2,
      maxTotalAttempts: 10,
      batchDelaySeconds: 30,
      maxBatchWaitSeconds: 120,
      quietPeriodSeconds: 180,
      trustedBotLogins: ['example-review[bot]'],
    });
    expect(hasWatchPrAutomaticWriteConsent(policy)).toBe(true);
    expect(watchPrMaintenancePolicySchema.parse(policyInput).trustedBotLogins).toContain(
      'kiloconnect-lite[bot]'
    );
    expect(
      watchPrMaintenancePolicySchema.safeParse({ ...policyInput, maxTotalAttempts: 11 }).success
    ).toBe(false);
    expect(
      watchPrMaintenancePolicySchema.safeParse({ ...policyInput, maxTotalAttempts: 1 }).success
    ).toBe(false);
    expect(
      watchPrMaintenancePolicySchema.safeParse({ ...policyInput, branchStrategy: 'merge' }).success
    ).toBe(false);
    expect(
      watchPrMaintenancePolicySchema.safeParse({
        ...policyInput,
        batchDelaySeconds: 120,
        maxBatchWaitSeconds: 30,
      }).success
    ).toBe(false);
  });

  it('separates immutable batch input from later events and bounds retained context', () => {
    const original = input();
    const parsed = watchPrMaintenanceInputSchema.parse(original);
    original.problems.push({ ...problem, problemKey: 'later-event' });
    expect(parsed.problems).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.problems)).toBe(true);
    expect(Object.isFrozen(parsed.problems[0])).toBe(true);
    expect(
      watchPrMaintenanceInputSchema.safeParse({ ...input(), problems: [problem, problem] }).success
    ).toBe(false);
    expect(
      watchPrMaintenanceInputSchema.safeParse({
        ...input(),
        problems: Array.from(
          { length: watchPrMaintenanceDefaults.maxProblemsPerBatch + 1 },
          (_, i) => ({ ...problem, problemKey: `problem-${i}` })
        ),
      }).success
    ).toBe(false);
    expect(
      watchPrMaintenanceInputSchema.safeParse({ ...input(), policy: legacyPolicy }).success
    ).toBe(false);
  });

  it('reads logs for at most three failing jobs per batch', () => {
    const problems = Array.from({ length: 4 }, (_, index) => ({
      kind: 'failed_check',
      problemKey: `check:${index}`,
      contentFingerprint: `check:${index}:revision`,
      headSha,
      checkId: String(index),
      name: `Synthetic job ${index}`,
      detailsUrl: null,
      log: 'Trimmed failure log',
      logUnavailableReason: null,
    }));
    expect(watchPrMaintenanceInputSchema.safeParse({ ...input(), problems }).success).toBe(false);
    expect(
      watchPrMaintenanceInputSchema.safeParse({ ...input(), problems: problems.slice(0, 3) })
        .success
    ).toBe(true);
  });

  it('requires exact Git publication evidence and strict normalized timestamps', () => {
    const evidence = {
      status: 'published',
      source: 'git',
      repoUrl: 'https://github.com/example/maintenance',
      headRef: 'feature/repair',
      observedHeadSha: headSha,
      pushedHeadSha: publishedSha,
      remoteHeadSha: publishedSha,
      baseSha,
      exactLease: `refs/heads/feature/repair:${headSha}`,
      pushExitCode: 0,
      verifiedAt: '2026-11-12T01:16:12.945Z',
    };
    expect(watchPrPublicationEvidenceSchema.parse(evidence)).toEqual(evidence);
    const ownedRebase = {
      source: 'git',
      attemptId: '11111111-1111-4111-8111-111111111111',
      baseSha,
      previousHeadSha: headSha,
      rebasedHeadSha: publishedSha,
      completedAt: '2026-11-12T01:15:00.000Z',
    };
    expect(watchPrPublicationEvidenceSchema.parse({ ...evidence, ownedRebase })).toEqual({
      ...evidence,
      ownedRebase,
    });
    for (const patch of [
      { source: 'agent_summary' },
      { attemptId: 'not-an-attempt' },
      { baseSha: headSha },
      { completedAt: '2026-11-12T01:17:00.000Z' },
    ]) {
      expect(
        watchPrPublicationEvidenceSchema.safeParse({
          ...evidence,
          ownedRebase: { ...ownedRebase, ...patch },
        }).success
      ).toBe(false);
    }
    for (const patch of [
      { source: 'agent_summary' },
      { remoteHeadSha: headSha },
      { exactLease: 'refs/heads/feature/repair' },
      { pushExitCode: 1 },
      { verifiedAt: '2026-11-12 01:16:12.945+00' },
    ])
      expect(watchPrPublicationEvidenceSchema.safeParse({ ...evidence, ...patch }).success).toBe(
        false
      );
    expect(
      watchPrPublicationEvidenceSchema.parse({
        ...evidence,
        verifiedAt: new Date('2026-11-12 01:16:12.945+00').toISOString(),
      })
    ).toEqual(evidence);
    expect(
      watchPrPublicationEvidenceSchema.safeParse({ status: 'published', summary: 'Push succeeded' })
        .success
    ).toBe(false);
  });

  it('rejects noncanonical repositories and unsafe branch identities', () => {
    for (const repoUrl of [
      'https://github.com/example/maintenance?token=synthetic',
      'https://github.com/example/maintenance.git',
      'https://github.com/example/maintenance#fragment',
      'https://github.com/example/maintenance\n',
    ]) {
      expect(
        watchPrMaintenanceInputSchema.safeParse({
          ...input(),
          repository: { ...input().repository, repoUrl },
        }).success
      ).toBe(false);
    }
    for (const headRef of [
      '--all',
      'feature:other',
      'feature bad',
      'feature..bad',
      'feature.lock',
      'feature/.hidden',
    ]) {
      expect(
        watchPrMaintenanceInputSchema.safeParse({
          ...input(),
          repository: { ...input().repository, headRef },
        }).success
      ).toBe(false);
    }
  });

  it('preserves unsuccessful publication separately from completed agent work', () => {
    const result = watchPrMaintenanceResultSchema.parse({
      version: 1,
      summary: 'The lease rejected the push.',
      changedFiles: ['src/synthetic.ts'],
      verification: [],
      publication: { status: 'failed', reason: 'The remote branch changed.' },
      problems: [],
      needsInput: null,
    });
    expect(result.publication.status).toBe('failed');
    expect(
      watchPrProblemResultSchema.safeParse({
        problemKey: 'review:1',
        contentFingerprint: 'revision-1',
        disposition: 'disagreed',
        reason: 'The current code contradicts the suggestion.',
        evidence: [],
        threadId: 'synthetic-thread',
        reply: 'Leave this thread open.',
        resolve: true,
      }).success
    ).toBe(false);
  });

  it('keeps questions active and removes terminal attempts from automatic pinning', () => {
    expect(
      ['creating', 'running', 'needs_input'].map(status =>
        isLiveWatchPrAttempt(status as 'creating' | 'running' | 'needs_input')
      )
    ).toEqual([true, true, true]);
    expect(isLiveWatchPrAttempt('completed')).toBe(false);
    expect(isLiveWatchPrAttempt('failed')).toBe(false);
    expect(isLiveWatchPrAttempt('stopped')).toBe(false);
  });
});

describe('PR maintenance storage contracts', () => {
  it('reserves one live attempt per workspace, including questions', () => {
    const config = getTableConfig(cloud_agent_pr_maintenance_attempts);
    const liveIndex = config.indexes.find(
      index => index.config.name === 'UQ_cloud_agent_pr_maintenance_attempts_live_workspace'
    );
    expect(liveIndex?.config.unique).toBe(true);
    const where = liveIndex?.config.where;
    if (!where) throw new Error('Missing live attempt index condition');
    expect(new PgDialect().sqlToQuery(where).sql).toContain(
      "IN ('creating', 'running', 'needs_input')"
    );
  });

  it('cascades private inputs, results, and dispositions from the watch', () => {
    for (const table of [
      cloud_agent_pr_maintenance_attempts,
      cloud_agent_pr_feedback_dispositions,
    ]) {
      const watchForeignKey = getTableConfig(table).foreignKeys.find(
        key => key.reference().columns[0]?.name === 'watch_id'
      );
      expect(watchForeignKey?.onDelete).toBe('cascade');
    }
    const chatConfig = getTableConfig(cli_sessions_v2);
    expect(chatConfig.columns.find(column => column.name === 'chat_kind')?.default).toBe('user');
    for (const column of ['maintenance_watch_id', 'maintenance_attempt_id']) {
      expect(
        chatConfig.foreignKeys.find(key => key.reference().columns[0]?.name === column)?.onDelete
      ).toBeUndefined();
    }
  });

  it('makes concurrent chat metadata indexes retry-safe without changing generated definitions', () => {
    const migration = readFileSync(
      join(__dirname, 'migrations/0358_cloud_agent_pr_maintenance.sql'),
      'utf8'
    );
    const statements = migration
      .split('--> statement-breakpoint')
      .map(statement => statement.trim());
    expect(statements[0]).toContain(
      "IF to_regclass('public.cloud_agent_pr_feedback_dispositions') IS NULL THEN"
    );
    expect(statements[0]).toContain('ADD COLUMN "chat_kind"');
    expect(statements[0]).toMatch(/END IF;\s*END \$\$;$/);
    const commit = statements.indexOf('COMMIT;');
    expect(statements.slice(commit, commit + 13)).toEqual([
      'COMMIT;',
      'SET statement_timeout = 0;',
      'SET lock_timeout = 0;',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_maintenance_watch";',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_cli_sessions_v2_maintenance_attempt";',
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_cloud_agent_pr_watches_due";',
      'CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_maintenance_watch" ON "cli_sessions_v2" USING btree ("maintenance_watch_id") WHERE "cli_sessions_v2"."maintenance_watch_id" is not null;',
      'CREATE INDEX CONCURRENTLY "IDX_cli_sessions_v2_maintenance_attempt" ON "cli_sessions_v2" USING btree ("maintenance_attempt_id") WHERE "cli_sessions_v2"."maintenance_attempt_id" is not null;',
      'CREATE INDEX CONCURRENTLY "IDX_cloud_agent_pr_watches_due" ON "cloud_agent_pr_watches" USING btree ("next_run_at") WHERE "cloud_agent_pr_watches"."status" = \'watching\' AND "cloud_agent_pr_watches"."next_run_at" IS NOT NULL;',
      'RESET lock_timeout;',
      'RESET statement_timeout;',
      'BEGIN;',
      expect.stringContaining('cloud_agent_pr_watches_execution_status_check'),
    ]);
  });
});
