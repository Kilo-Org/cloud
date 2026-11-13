import type { CloudAgentPrMaintenanceAttempt } from '@kilocode/db/schema';
import { maintenanceHistoryEntry } from './watch-pr-maintenance-history';
import { getMaintenanceRecoveryAction } from './watch-pr-maintenance-reasons';

it('returns bounded history without full prompts, CI logs, or inherited transcripts', () => {
  const attempt = {
    id: '10000000-0000-4000-8000-000000000001',
    ordinal: 1,
    status: 'completed',
    session_id: 'ses_example',
    cloud_agent_session_id: 'workspace_example',
    created_at: '2026-11-12 12:00:00+00',
    updated_at: '2026-11-12 12:01:00+00',
    reason: null,
    input: {
      purpose: 'PRIVATE_FULL_PROMPT',
      previousResults: [{ summary: 'PRIVATE_INHERITED_RESULT' }],
      repository: { baseRef: 'main' },
      problems: [
        {
          kind: 'failed_check',
          problemKey: 'check:lint',
          name: 'Lint',
          log: 'PRIVATE_JOB_LOG'.repeat(15_000),
        },
        { kind: 'review', problemKey: 'comment:1', body: 'x'.repeat(12_000) },
      ],
    },
    result: {
      summary: 's'.repeat(8_000),
      changedFiles: Array.from({ length: 200 }, () => 'p'.repeat(1000)),
      verification: [
        { command: 'pnpm test', outcome: 'passed', summary: 'Passed', evidenceUrls: [] },
      ],
      publication: { status: 'not_attempted', reason: 'No publication' },
      needsInput: null,
    },
  } as unknown as CloudAgentPrMaintenanceAttempt;
  const dto = maintenanceHistoryEntry(attempt, { total_cost_microdollars: 123 });
  expect(dto).toMatchObject({
    chatAvailable: true,
    total_cost_microdollars: 123,
    created_at: '2026-11-12T12:00:00.000Z',
  });
  expect(dto).not.toHaveProperty('input');
  expect(dto.triggers[1].label).toHaveLength(500);
  expect(dto.result?.changedFiles).toHaveLength(50);
  expect(dto.result?.changedFileCount).toBe(200);
  expect(JSON.stringify(dto)).not.toMatch(/PRIVATE_/);
  expect(JSON.stringify(dto).length).toBeLessThan(20_000);
});

it('caps large history rows while retaining truthful list totals', () => {
  const attempt = {
    id: '10000000-0000-4000-8000-000000000001',
    ordinal: 1,
    status: 'completed',
    session_id: null,
    cloud_agent_session_id: null,
    created_at: '2026-11-12T12:00:00Z',
    updated_at: '2026-11-12T12:00:00Z',
    reason: null,
    input: {
      repository: { baseRef: 'main' },
      problems: Array.from({ length: 20 }, (_, index) => ({
        kind: 'review',
        problemKey: `comment:${index}`,
        body: 'x'.repeat(12_000),
      })),
    },
    result: {
      summary: 's'.repeat(2_000),
      changedFiles: Array.from({ length: 50 }, () => 'f'.repeat(1000)),
      verification: Array.from({ length: 10 }, () => ({
        command: 'c'.repeat(500),
        outcome: 'passed',
        summary: 's'.repeat(500),
        evidenceUrls: Array.from({ length: 3 }, () => `https://example.com/${'u'.repeat(1900)}`),
      })),
      publication: { status: 'not_attempted', reason: 'No publication' },
      needsInput: null,
    },
  } as unknown as CloudAgentPrMaintenanceAttempt;
  const dto = maintenanceHistoryEntry(attempt, null);
  expect(JSON.stringify(dto).length).toBeLessThanOrEqual(24_000);
  expect(dto).toMatchObject({
    triggerCount: 20,
    result: { changedFileCount: 50, verificationCount: 10 },
  });
});

it.each([
  ['maintenance_chat_stopped', 'resume'],
  ['maintenance_workspace_settings_changed', 'reenable'],
  ['maintenance_parent_commit_unavailable', 'recheck_after_fix'],
  ['total_attempt_limit', 'manual'],
  ['publication_unverified', 'manual'],
  ['rate_limited', 'none'],
  ['unknown_future_reason', 'manual'],
] as const)('classifies %s recovery without parsing error prose', (reason, action) => {
  expect(getMaintenanceRecoveryAction(reason)).toBe(action);
});
