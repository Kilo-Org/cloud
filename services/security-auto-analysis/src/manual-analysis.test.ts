import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureManualAnalysisQueueRow } from './db/queries.js';
import { startSecurityAnalysis } from './launch.js';
import { processManualAnalysisStart, type ManualAnalysisStartCommand } from './manual-analysis.js';

vi.mock('./launch.js', () => ({
  startSecurityAnalysis: vi.fn(),
}));

const command: ManualAnalysisStartCommand = {
  schemaVersion: 1,
  findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  actorUserId: 'user-123',
};

const finding = {
  id: command.findingId,
  owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owned_by_user_id: null,
  repo_full_name: 'kilo/repo',
  source: 'dependabot',
  source_id: '42',
  severity: 'high',
};

beforeEach(() => {
  vi.mocked(startSecurityAnalysis).mockReset();
});

describe('processManualAnalysisStart', () => {
  it('rejects manual starts for findings owned by another tenant', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                ...finding,
                owned_by_organization_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              },
            ],
          }),
        }),
      }),
    };

    await expect(
      processManualAnalysisStart({ db: db as never, env: {} as CloudflareEnv, command })
    ).resolves.toEqual({ status: 'finding-missing' });
    expect(startSecurityAnalysis).not.toHaveBeenCalled();
  });

  it('enforces owner cap before claiming a manual queue row', async () => {
    let selectCount = 0;
    const db = {
      select: () => {
        selectCount += 1;
        if (selectCount === 1) {
          return { from: () => ({ where: () => ({ limit: async () => [finding] }) }) };
        }
        return { from: () => ({ where: async () => [{ total: 3 }] }) };
      },
    };

    await expect(
      processManualAnalysisStart({ db: db as never, env: {} as CloudflareEnv, command })
    ).resolves.toEqual({ status: 'owner-cap' });
  });

  it('persists actor-selected model context in Worker launch and audit metadata', async () => {
    let selectCount = 0;
    let insertCount = 0;
    const auditRows: unknown[] = [];
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const db = {
      select: () => {
        selectCount += 1;
        if (selectCount === 1) {
          return { from: () => ({ where: () => ({ limit: async () => [finding] }) }) };
        }
        if (selectCount === 2) {
          return { from: () => ({ where: async () => [{ total: 0 }] }) };
        }
        if (selectCount === 3) {
          return {
            from: () => ({
              where: () => ({ limit: async () => [{ id: 'user-123', api_token_pepper: null }] }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  config: {
                    analysis_mode: 'deep',
                    triage_model_slug: 'config/triage',
                    analysis_model_slug: 'config/analysis',
                  },
                },
              ],
            }),
          }),
        };
      },
      insert: () => {
        insertCount += 1;
        if (insertCount === 1) {
          return {
            values: () => ({
              onConflictDoNothing: () => ({ returning: async () => [{ id: 'queue-row' }] }),
            }),
          };
        }
        return {
          values: async (values: unknown) => {
            auditRows.push(values);
          },
        };
      },
      execute,
    };
    vi.mocked(startSecurityAnalysis).mockResolvedValue({ started: true, triageOnly: false });

    await expect(
      processManualAnalysisStart({
        db: db as never,
        env: {
          GIT_TOKEN_SERVICE: {
            getTokenForRepo: async () => ({
              success: true,
              token: 'github-token',
              installationId: 'installation-123',
              accountLogin: 'kilo',
              appType: 'standard',
            }),
          },
          NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
          INTERNAL_API_SECRET: { get: async () => 'internal-secret' },
        } as unknown as CloudflareEnv,
        command: {
          ...command,
          requestedModels: { triageModel: 'request/triage', analysisModel: 'request/analysis' },
          retrySandboxOnly: true,
        },
      })
    ).resolves.toEqual({ status: 'started' });

    expect(startSecurityAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUser: { id: 'user-123', api_token_pepper: null },
        triageModel: 'request/triage',
        analysisModel: 'request/analysis',
        analysisMode: 'deep',
        retrySandboxOnly: true,
      })
    );
    expect(auditRows[0]).toMatchObject({
      actor_id: 'user-123',
      metadata: {
        model: 'request/analysis',
        triageModel: 'request/triage',
        analysisModel: 'request/analysis',
        analysisMode: 'deep',
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('ensureManualAnalysisQueueRow', () => {
  it('records claimed pending manual queue state with owner and claim correlation', async () => {
    const inserted: unknown[] = [];
    const db = {
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

    await expect(
      ensureManualAnalysisQueueRow(db as never, {
        finding: finding as never,
        claimToken: 'claim-token',
        jobId: 'manual-job',
      })
    ).resolves.toBe(true);
    expect(inserted[0]).toMatchObject({
      finding_id: command.findingId,
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      queue_status: 'pending',
      claim_token: 'claim-token',
      claimed_by_job_id: 'manual-job',
    });
  });

  it('reports duplicate manual starts when the finding queue row already exists', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
    };

    await expect(
      ensureManualAnalysisQueueRow(db as never, {
        finding: finding as never,
        claimToken: 'claim-token',
        jobId: 'manual-job',
      })
    ).resolves.toBe(false);
  });
});
