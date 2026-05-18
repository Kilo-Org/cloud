import { describe, expect, it } from 'vitest';
import {
  isFindingEligibleForAutoAnalysis,
  selectRepositoriesForSync,
  syncAutoAnalysisQueueForFinding,
} from './sync.js';

describe('selectRepositoriesForSync', () => {
  it('allows a manual repository command to target an accessible repo outside configured sync selection', () => {
    const repositories = selectRepositoriesForSync(
      {
        repositories: ['kilo/configured'],
        repoNameToId: new Map([
          ['kilo/configured', 1],
          ['kilo/requested', 2],
        ]),
      },
      'kilo/requested'
    );

    expect(repositories).toEqual(['kilo/requested']);
  });
});

describe('Worker auto-analysis queue sync', () => {
  it('matches automatic-analysis eligibility boundaries for newly synced findings', () => {
    expect(
      isFindingEligibleForAutoAnalysis({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        severity: 'high',
        ownerAutoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'high',
      })
    ).toEqual({ eligible: true, severityRank: 1 });

    expect(
      isFindingEligibleForAutoAnalysis({
        findingCreatedAt: '2026-05-18T08:00:00.000Z',
        findingStatus: 'open',
        severity: 'high',
        ownerAutoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'high',
      })
    ).toEqual({ eligible: false, severityRank: 1 });
  });

  it('enqueues eligible findings for Worker-owned automatic analysis', async () => {
    const inserted: unknown[] = [];
    const tx = {
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              inserted.push(values);
              return [{ id: 'queue-row' }];
            },
          }),
        }),
      }),
    };
    const db = {
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
    };

    await expect(
      syncAutoAnalysisQueueForFinding(db as never, {
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        previousStatus: null,
        currentStatus: 'open',
        severity: 'critical',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'high',
        ownerAutoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
      })
    ).resolves.toEqual({
      enqueueCount: 1,
      eligibleCount: 1,
      boundarySkipCount: 0,
      unknownSeverityCount: 0,
    });
    expect(inserted[0]).toMatchObject({
      finding_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      queue_status: 'queued',
      severity_rank: 0,
    });
  });
});
