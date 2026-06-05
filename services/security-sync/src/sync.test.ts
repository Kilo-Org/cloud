import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllDependabotAlerts,
  isFindingEligibleForAutoAnalysis,
  selectRepositoriesForSync,
  syncAutoAnalysisQueueForFinding,
  syncOwner,
} from './sync.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type FakeDbOptions = {
  authInvalidAt?: string | null;
  repositories?: string[];
};

function createFakeDb(options: FakeDbOptions = {}) {
  const repositories = options.repositories ?? ['acme/widgets'];
  const sets: Array<Record<string, unknown>> = [];
  let selectCount = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            selectCount++;
            if (selectCount === 1) {
              return [{ id: 'agent-config', config: {}, is_enabled: true }];
            }
            if (selectCount === 2) {
              return [
                {
                  id: 'integration-1',
                  platform_installation_id: 'installation-1',
                  permissions: { vulnerability_alerts: 'read' },
                  repositories: repositories.map((full_name, index) => ({
                    id: index + 1,
                    full_name,
                  })),
                  authInvalidAt: options.authInvalidAt ?? null,
                },
              ];
            }
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({ values: async () => undefined }),
    execute: async () => ({ rows: [] }),
  };

  return { db, sets };
}

function createGitTokenService() {
  return { getToken: vi.fn(async () => 'github-token') };
}

function stubFetch(response: Response | (() => Response)) {
  const fetchStub = vi.fn(async () => (typeof response === 'function' ? response() : response));
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

function createDependabotAlert(overrides: Record<string, unknown> = {}) {
  return {
    number: 23,
    state: 'open',
    dependency: {
      package: { ecosystem: 'npm', name: 'lodash' },
      manifest_path: 'package.json',
      scope: 'runtime',
    },
    security_advisory: {
      ghsa_id: 'GHSA-1234-5678-90ab',
      cve_id: null,
      summary: 'Prototype pollution in lodash',
      description: 'A vulnerable lodash version allows prototype pollution.',
      severity: 'high',
      cvss: { score: 7.5, vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      cwes: [{ cwe_id: 'CWE-1321', name: 'Improperly Controlled Modification' }],
    },
    security_vulnerability: {
      vulnerable_version_range: '< 4.17.21',
      first_patched_version: { identifier: '4.17.21' },
    },
    created_at: '2026-05-18T10:00:00Z',
    updated_at: '2026-05-18T10:00:00Z',
    fixed_at: null,
    dismissed_at: null,
    dismissed_by: null,
    dismissed_reason: null,
    dismissed_comment: null,
    html_url: 'https://github.com/acme/widgets/security/dependabot/23',
    url: 'https://api.github.com/repos/acme/widgets/dependabot/alerts/23',
    ...overrides,
  };
}

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

describe('Worker GitHub auth-invalid sync', () => {
  it('accepts Dependabot alerts with nullable advisory fields', async () => {
    const alert = createDependabotAlert({
      security_advisory: {
        ...createDependabotAlert().security_advisory,
        cvss: { score: 7.5, vector_string: null },
      },
      security_vulnerability: {
        vulnerable_version_range: '< 4.17.21',
        first_patched_version: null,
      },
    });
    stubFetch(new Response(JSON.stringify([alert]), { status: 200 }));

    await expect(fetchAllDependabotAlerts('github-token', 'acme', 'widgets')).resolves.toEqual({
      status: 'success',
      alerts: [alert],
    });
  });

  it('classifies a direct GitHub 401 as auth_invalid', async () => {
    stubFetch(new Response('Bad credentials', { status: 401 }));

    await expect(fetchAllDependabotAlerts('github-token', 'acme', 'widgets')).resolves.toEqual({
      status: 'auth_invalid',
    });
  });

  it('persists the first GitHub 401 and stops syncing remaining repos', async () => {
    const { db, sets } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('Bad credentials', { status: 401 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({
      authInvalid: 1,
      authInvalidRepos: ['acme/widgets'],
      reauthRequired: true,
      errors: 0,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(gitTokenService.getToken).toHaveBeenCalledTimes(1);
    expect(sets).toContainEqual(
      expect.objectContaining({ auth_invalid_reason: 'github_dependabot_401' })
    );
    expect(sets).not.toContainEqual(expect.objectContaining({ runtime_state: expect.anything() }));
  });

  it('short-circuits a recent invalid marker before token minting or GitHub fetch', async () => {
    const { db } = createFakeDb({
      authInvalidAt: new Date().toISOString(),
      repositories: ['acme/widgets', 'acme/api'],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({
      authInvalid: 2,
      authInvalidRepos: ['acme/widgets', 'acme/api'],
      reauthRequired: true,
    });

    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refreshes an expired marker after GitHub still returns 401', async () => {
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('Bad credentials', { status: 401 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ authInvalid: 1, reauthRequired: true });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sets).toContainEqual(
      expect.objectContaining({ auth_invalid_reason: 'github_dependabot_401' })
    );
  });

  it('clears invalid state after success and advances full-sync freshness', async () => {
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ authInvalid: 0, reauthRequired: false });

    expect(sets).toContainEqual(
      expect.objectContaining({ auth_invalid_at: null, auth_invalid_reason: null })
    );
    expect(sets).toContainEqual(expect.objectContaining({ runtime_state: expect.anything() }));
  });

  it('does not advance freshness after mixed success then GitHub 401', async () => {
    const { db, sets } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
    const gitTokenService = createGitTokenService();
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }));
    vi.stubGlobal('fetch', fetchStub);

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ authInvalid: 1, reauthRequired: true });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(sets).not.toContainEqual(expect.objectContaining({ runtime_state: expect.anything() }));
  });

  it('throws non-401 GitHub errors', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    stubFetch(new Response('Service unavailable', { status: 500 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).rejects.toThrow('GitHub API error 500 for acme/widgets: Service unavailable');
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

    expect(
      isFindingEligibleForAutoAnalysis({
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        findingStatus: 'open',
        severity: 'unexpected',
        ownerAutoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'all',
      })
    ).toEqual({ eligible: true, severityRank: 3 });
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

  it('enqueues unknown severity at the all threshold using the durable low queue rank', async () => {
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
        findingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        findingCreatedAt: '2026-05-18T10:00:00.000Z',
        previousStatus: null,
        currentStatus: 'open',
        severity: 'unexpected',
        isAgentEnabled: true,
        autoAnalysisEnabled: true,
        autoAnalysisMinSeverity: 'all',
        ownerAutoAnalysisEnabledAt: '2026-05-18T09:00:00.000Z',
      })
    ).resolves.toEqual({
      enqueueCount: 1,
      eligibleCount: 1,
      boundarySkipCount: 0,
      unknownSeverityCount: 1,
    });
    expect(inserted[0]).toMatchObject({
      finding_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      queue_status: 'queued',
      severity_rank: 3,
    });
  });
});
