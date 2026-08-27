import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  fetchAllDependabotAlerts,
  isFindingEligibleForAutoAnalysis,
  selectRepositoriesForSync,
  syncAutoAnalysisQueueForFinding,
  syncOwner,
  upsertSecurityFinding,
} from './sync.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type FakeDbOptions = {
  authInvalidAt?: string | null;
  repositories?: string[];
  runtimeState?: Record<string, unknown>;
  integrations?: Array<{
    id: string;
    installationId: string;
    appType?: 'standard' | 'lite';
    status?: string;
    suspendedAt?: string | null;
    authInvalidAt?: string | null;
    permissions?: Record<string, string>;
    repositories: Array<{ id: number; fullName: string }>;
  }>;
};

function createFakeDb(options: FakeDbOptions = {}) {
  const repositories = options.repositories ?? ['acme/widgets'];
  const sets: Array<Record<string, unknown>> = [];
  let selectCount = 0;

  const integrations = options.integrations?.map(integration => ({
    id: integration.id,
    platform_installation_id: integration.installationId,
    permissions: integration.permissions ?? { vulnerability_alerts: 'read' },
    repositories: integration.repositories.map(repository => ({
      id: repository.id,
      name: repository.fullName.split('/')[1] ?? repository.fullName,
      full_name: repository.fullName,
      private: true,
    })),
    authInvalidAt: integration.authInvalidAt ?? null,
    integrationStatus: integration.status ?? 'active',
    suspendedAt: integration.suspendedAt ?? null,
    appType: integration.appType ?? 'standard',
  })) ?? [
    {
      id: 'integration-1',
      platform_installation_id: 'installation-1',
      permissions: { vulnerability_alerts: 'read' },
      repositories: repositories.map((full_name, index) => ({
        id: index + 1,
        name: full_name.split('/')[1] ?? full_name,
        full_name,
        private: true,
      })),
      authInvalidAt: options.authInvalidAt ?? null,
      integrationStatus: 'active',
      suspendedAt: null,
      appType: 'standard' as const,
    },
  ];

  const db = {
    select: () => {
      selectCount++;
      const rows =
        selectCount === 1
          ? [
              {
                id: 'agent-config',
                config: {},
                is_enabled: true,
                runtime_state: options.runtimeState ?? {},
              },
            ]
          : selectCount === 2
            ? integrations
            : [];
      return {
        from: () => ({
          where: () => {
            const query = Promise.resolve(rows);
            return Object.assign(query, { limit: async () => rows });
          },
        }),
      };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
    execute: async () => ({ rows: [] }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(db),
  };

  return { db, sets };
}

function runtimeStateSqlText(entry: Record<string, unknown>): string {
  const value = entry.runtime_state;
  if (value == null || typeof value !== 'object') return '';
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> }).queryChunks;
  if (!Array.isArray(chunks)) return '';
  return chunks
    .flatMap(chunk => (Array.isArray(chunk.value) ? chunk.value : []))
    .filter(part => typeof part === 'string')
    .join('');
}

function createGitTokenService(): {
  getToken: ReturnType<
    typeof vi.fn<(installationId: string, appType?: 'standard' | 'lite') => Promise<string>>
  >;
} {
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

describe('Worker GitHub repository integration planning', () => {
  it('syncs repositories split across healthy organization integrations with each app type', async () => {
    const { db } = createFakeDb({
      integrations: [
        {
          id: 'integration-standard',
          installationId: 'installation-standard',
          appType: 'standard',
          repositories: [{ id: 1, fullName: 'acme/widgets' }],
        },
        {
          id: 'integration-lite',
          installationId: 'installation-lite',
          appType: 'lite',
          repositories: [{ id: 2, fullName: 'acme/api' }],
        },
      ],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(() => new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        runId: 'run-split',
      })
    ).resolves.toMatchObject({ errors: 0, remainingRepoCount: 0 });

    expect(gitTokenService.getToken).toHaveBeenNthCalledWith(
      1,
      'installation-standard',
      'standard'
    );
    expect(gitTokenService.getToken).toHaveBeenNthCalledWith(2, 'installation-lite', 'lite');
    expect(fetchStub).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/acme/widgets/dependabot/alerts?per_page=100',
      expect.any(Object)
    );
    expect(fetchStub).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/acme/api/dependabot/alerts?per_page=100',
      expect.any(Object)
    );
  });

  it('ignores an unhealthy sibling while syncing a healthy organization integration', async () => {
    const { db } = createFakeDb({
      integrations: [
        {
          id: 'integration-unhealthy',
          installationId: 'installation-unhealthy',
          status: 'suspended',
          repositories: [{ id: 1, fullName: 'acme/old' }],
        },
        {
          id: 'integration-healthy',
          installationId: 'installation-healthy',
          appType: 'lite',
          repositories: [{ id: 2, fullName: 'acme/api' }],
        },
      ],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      runId: 'run-healthy-sibling',
    });

    expect(gitTokenService.getToken).toHaveBeenCalledOnce();
    expect(gitTokenService.getToken).toHaveBeenCalledWith('installation-healthy', 'lite');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('fails closed when a configured repository is visible through multiple integrations', async () => {
    const { db } = createFakeDb({
      integrations: [
        {
          id: 'integration-standard',
          installationId: 'installation-standard',
          repositories: [{ id: 1, fullName: 'acme/widgets' }],
        },
        {
          id: 'integration-lite',
          installationId: 'installation-lite',
          appType: 'lite',
          repositories: [{ id: 1, fullName: 'ACME/WIDGETS' }],
        },
      ],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        runId: 'run-ambiguous',
      })
    ).resolves.toMatchObject({
      commandResultCode: 'AMBIGUOUS_GITHUB_INTEGRATION',
      synced: 0,
      errors: 0,
    });

    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('continues syncing a healthy sibling after another installation returns 401', async () => {
    const { db } = createFakeDb({
      integrations: [
        {
          id: 'integration-invalid',
          installationId: 'installation-invalid',
          repositories: [
            { id: 1, fullName: 'acme/widgets' },
            { id: 2, fullName: 'acme/website' },
          ],
        },
        {
          id: 'integration-healthy',
          installationId: 'installation-healthy',
          appType: 'lite',
          repositories: [{ id: 3, fullName: 'acme/api' }],
        },
      ],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        runId: 'run-partial-auth',
      })
    ).resolves.toMatchObject({
      authInvalid: 2,
      authInvalidRepos: ['acme/widgets', 'acme/website'],
      reauthRequired: true,
    });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(gitTokenService.getToken).toHaveBeenNthCalledWith(1, 'installation-invalid', 'standard');
    expect(gitTokenService.getToken).toHaveBeenNthCalledWith(2, 'installation-healthy', 'lite');
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

  it('persists the first GitHub 401 and skips remaining repos on that installation', async () => {
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
      authInvalid: 2,
      authInvalidRepos: ['acme/widgets', 'acme/api'],
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

  it('records disabled Dependabot alerts as a repository sync failure', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    const upsertUpdates: Array<Record<string, unknown>> = [];
    const originalInsert = db.insert;
    db.insert = () => ({
      values: () => ({
        onConflictDoUpdate: async (config?: { set?: Record<string, unknown> }) => {
          if (config?.set) upsertUpdates.push(config.set);
        },
      }),
    });
    stubFetch(new Response('Dependabot alerts are disabled', { status: 422 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ skipped: 1 });

    expect(upsertUpdates).toContainEqual(
      expect.objectContaining({ last_failure_code: 'DEPENDABOT_ALERTS_DISABLED' })
    );
    db.insert = originalInsert;
  });

  it('throws non-401 GitHub errors', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    stubFetch(new Response('Service unavailable', { status: 500 }));

    let thrown: unknown;
    try {
      await syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new Error('GitHub API error 500 for acme/widgets'));
    expect(thrown).not.toHaveProperty('message', expect.stringContaining('Service unavailable'));
  });

  it('records a v1 finding-created audit event when importing a new alert', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    const auditRows: Array<Record<string, unknown>> = [];
    const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let executeCount = 0;
    const mutableDb = db as unknown as {
      execute: () => Promise<{ rows: unknown[] }>;
      insert: () => {
        values: (values: Record<string, unknown>) => {
          onConflictDoNothing: () => { returning: () => Promise<Array<{ id: string }>> };
          onConflictDoUpdate: () => Promise<undefined>;
        };
      };
    };

    mutableDb.execute = async () => {
      executeCount++;
      if (executeCount === 1) {
        return {
          rows: [
            {
              findingId,
              wasInserted: true,
              previousStatus: null,
              previousSeverity: null,
              effectiveStatus: 'open',
              effectiveSeverity: 'high',
              findingCreatedAt: '2026-05-18T10:00:00.000Z',
              ownedByUserId: 'user-1',
              ownedByOrganizationId: null,
              source: 'dependabot',
              sourceId: '23',
              repoFullName: 'acme/widgets',
              title: 'Prototype pollution in lodash',
              packageName: 'lodash',
              packageEcosystem: 'npm',
              manifestPath: 'package.json',
              patchedVersion: '4.17.21',
              ghsaId: 'GHSA-1234-5678-90ab',
              cveId: null,
              cweIds: ['CWE-1321'],
              cvssScore: '7.5',
              dependabotHtmlUrl: 'https://github.com/acme/widgets/security/dependabot/23',
              firstDetectedAt: '2026-05-18T10:00:00.000Z',
              fixedAt: null,
              slaDueAt: '2026-06-17T10:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    };
    mutableDb.insert = () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            auditRows.push(values);
            return [{ id: 'audit-row-1' }];
          },
        }),
        onConflictDoUpdate: async () => undefined,
      }),
    });
    stubFetch(new Response(JSON.stringify([createDependabotAlert()]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ synced: 1, errors: 0 });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.created',
      resource_type: 'security_finding',
      resource_id: findingId,
      finding_id: findingId,
      event_key:
        'security_finding_audit:v1:user%3Auser-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:security.finding.created:2026-05-18T10%3A00%3A00Z',
      schema_version: 1,
      source_context: 'security_sync',
      finding_snapshot: expect.objectContaining({
        finding_id: findingId,
        source: 'dependabot',
        repo_full_name: 'acme/widgets',
      }),
    });
  });

  it('updates a finding integration when authoritative sync observes repository movement', async () => {
    let upsertSql = '';
    const execute = vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>(async query => {
      upsertSql = new PgDialect().sqlToQuery(query).sql;
      return {
        rows: [
          {
            findingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            wasInserted: false,
            previousStatus: 'open',
            previousSeverity: 'high',
            effectiveStatus: 'open',
            effectiveSeverity: 'high',
            findingCreatedAt: '2026-05-18T10:00:00.000Z',
            ownedByUserId: null,
            ownedByOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            source: 'dependabot',
            sourceId: '23',
            repoFullName: 'acme/widgets',
            title: 'Prototype pollution in lodash',
            packageName: 'lodash',
            packageEcosystem: 'npm',
            manifestPath: 'package.json',
            patchedVersion: '4.17.21',
            ghsaId: 'GHSA-1234-5678-90ab',
            cveId: null,
            cweIds: ['CWE-1321'],
            cvssScore: '7.5',
            dependabotHtmlUrl: 'https://github.com/acme/widgets/security/dependabot/23',
            firstDetectedAt: '2026-05-18T10:00:00.000Z',
            fixedAt: null,
            slaDueAt: '2026-06-17T10:00:00.000Z',
          },
        ],
      };
    });

    await expect(
      upsertSecurityFinding({ execute } as never, {
        finding: createDependabotAlert() as never,
        owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        platformIntegrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        repoFullName: 'acme/widgets',
        slaDueAt: '2026-06-17T10:00:00.000Z',
      })
    ).resolves.toMatchObject({ findingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });

    expect(execute).toHaveBeenCalledOnce();
    expect(upsertSql).toContain('"platform_integration_id" = EXCLUDED."platform_integration_id"');
    expect(upsertSql).toContain(
      '"security_findings"."platform_integration_id" IS DISTINCT FROM EXCLUDED."platform_integration_id"'
    );
  });

  it('does not let unsafe source snapshot values block finding sync', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    const auditRows: Array<Record<string, unknown>> = [];
    const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let executeCount = 0;
    const mutableDb = db as unknown as {
      execute: () => Promise<{ rows: unknown[] }>;
      insert: () => {
        values: (values: Record<string, unknown>) => {
          onConflictDoNothing: () => { returning: () => Promise<Array<{ id: string }>> };
          onConflictDoUpdate: () => Promise<undefined>;
        };
      };
    };

    mutableDb.execute = async () => {
      executeCount++;
      if (executeCount === 1) {
        return {
          rows: [
            {
              findingId,
              wasInserted: true,
              previousStatus: null,
              previousSeverity: null,
              effectiveStatus: 'open',
              effectiveSeverity: 'high',
              findingCreatedAt: '2026-05-18T10:00:00.000Z',
              ownedByUserId: 'user-1',
              ownedByOrganizationId: null,
              source: 'dependabot',
              sourceId: '23',
              repoFullName: 'acme/widgets',
              title: 'Contact security@example.com or support@example.com about lodash',
              packageName: 'lodash',
              packageEcosystem: 'npm',
              manifestPath: 'package.json',
              patchedVersion: '4.17.21',
              ghsaId: 'GHSA-1234-5678-90ab',
              cveId: null,
              cweIds: ['CWE-1321'],
              cvssScore: '7.5',
              dependabotHtmlUrl: 'not a valid url',
              firstDetectedAt: '2026-05-18T10:00:00.000Z',
              fixedAt: null,
              slaDueAt: '2026-06-17T10:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    };
    mutableDb.insert = () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            auditRows.push(values);
            return [{ id: 'audit-row-1' }];
          },
        }),
        onConflictDoUpdate: async () => undefined,
      }),
    });
    stubFetch(
      new Response(
        JSON.stringify([
          createDependabotAlert({
            html_url: 'not a valid url',
            security_advisory: {
              ...createDependabotAlert().security_advisory,
              summary: 'Contact security@example.com or support@example.com about lodash',
            },
          }),
        ]),
        { status: 200 }
      )
    );

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ synced: 1, errors: 0 });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.finding_snapshot).toMatchObject({
      title: 'Contact [redacted-email] or [redacted-email] about lodash',
    });
    expect(auditRows[0]?.finding_snapshot).not.toHaveProperty('dependabot_html_url');
  });

  it('stops after the first repository when the owner budget is already exhausted', async () => {
    const { db, sets } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-budget-1',
        budgetMs: 0,
      })
    ).resolves.toMatchObject({
      exhaustedBudget: true,
      remainingRepoCount: 1,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const progressWrite = sets.find(entry => entry.runtime_state != null)?.runtime_state;
    expect(progressWrite).toBeDefined();
    expect(progressWrite).not.toHaveProperty('sync_run');
    expect(progressWrite).not.toHaveProperty('last_synced_at');
  });

  it('counts a fresh-run GitHub failure toward the owner budget and does not mark it complete', async () => {
    const { db } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('Service unavailable', { status: 500 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-budget-fail',
        budgetMs: 0,
      })
    ).resolves.toMatchObject({
      exhaustedBudget: true,
      remainingRepoCount: 2,
      errors: 0,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('does not keep an incomplete GitHub failure as an error after a successful retry', async () => {
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      runtimeState: {
        sync_run: {
          runId: 'run-budget-retry',
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
        },
      },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(() => new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-budget-retry',
      })
    ).resolves.toMatchObject({
      exhaustedBudget: false,
      remainingRepoCount: 0,
      errors: 0,
    });

    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(true);
  });

  it('skips completed repositories and finalizes freshness on the last chunk', async () => {
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      runtimeState: {
        sync_run: {
          runId: 'run-budget-1',
          completedRepos: ['acme/widgets'],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
        },
      },
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-budget-1',
      })
    ).resolves.toMatchObject({
      exhaustedBudget: false,
      remainingRepoCount: 0,
      authInvalid: 0,
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sets).toContainEqual(expect.objectContaining({ runtime_state: expect.anything() }));
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
