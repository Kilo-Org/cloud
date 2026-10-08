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
  runtimeState?: Record<string, unknown>;
  /** Default true; false makes the claim `returning()` yield zero rows. */
  claimAcquired?: boolean;
  /** Post-image of a successful claim; default `runtimeState`. */
  claimRuntimeState?: Record<string, unknown>;
  /** Default true; false makes the progress-write `returning()` yield zero rows. */
  writeAccepted?: boolean;
  /** Default true; false makes clear/freshness/release `returning()` yield zero rows. */
  terminalAccepted?: boolean;
  /** Runtime state returned by the deny/conflict read; default null (no row). */
  conflictRuntimeState?: Record<string, unknown> | null;
  /** Default false; true makes getOwnerConfig's first select return no row. */
  configMissing?: boolean;
};

function createFakeDb(options: FakeDbOptions = {}) {
  const repositories = options.repositories ?? ['acme/widgets'];
  const sets: Array<Record<string, unknown>> = [];
  const wheres: string[] = [];
  let selectCount = 0;
  let updateCount = 0;
  let conflictReadArmed = false;

  const selection = {
    limit: async () => {
      if (conflictReadArmed) {
        conflictReadArmed = false;
        return options.conflictRuntimeState
          ? [{ runtime_state: options.conflictRuntimeState }]
          : [];
      }
      selectCount++;
      if (selectCount === 1) {
        if (options.configMissing) return [];
        return [
          {
            id: 'agent-config',
            config: {},
            is_enabled: true,
            runtime_state: options.runtimeState ?? {},
          },
        ];
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
    orderBy: () => selection,
  };

  const updateReturning = (
    values: Record<string, unknown>,
    isClaim: boolean
  ): Array<Record<string, unknown>> => {
    if (isClaim) {
      if (options.claimAcquired === false) {
        conflictReadArmed = true;
        return [];
      }
      return [{ runtimeState: options.claimRuntimeState ?? options.runtimeState ?? {} }];
    }
    if (isProgressWrite(values)) {
      if (options.writeAccepted === false) {
        conflictReadArmed = true;
        return [];
      }
      return [{}];
    }
    if (options.terminalAccepted === false) {
      conflictReadArmed = true;
      return [];
    }
    return [{}];
  };

  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => selection,
        }),
        where: () => selection,
      }),
    }),
    update: () => {
      updateCount++;
      const isClaim = updateCount === 1;
      return {
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: (condition: unknown) => {
              wheres.push(sqlToText(condition));
              return {
                returning: async () => updateReturning(values, isClaim),
                then: (
                  resolve: (value: undefined) => unknown,
                  reject?: (error: unknown) => unknown
                ) => Promise.resolve(undefined).then(resolve, reject),
              };
            },
          };
        },
      };
    },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
    execute: async () => ({ rows: [] }),
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(db),
  };

  return { db, sets, wheres, selectCount: () => selectCount };
}

function isProgressWrite(values: Record<string, unknown>): boolean {
  return (
    values.runtime_state != null &&
    typeof values.runtime_state === 'object' &&
    sqlToText(values.runtime_state).includes('jsonb_agg')
  );
}

/** Flattens a Drizzle SQL object into text, including bound parameter values. */
function sqlToText(node: unknown): string {
  const parts: string[] = [];
  collectSqlParts(node, parts);
  return parts.join('');
}

function collectSqlParts(node: unknown, parts: string[]): void {
  if (node == null) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    parts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSqlParts(item, parts);
    return;
  }
  if (typeof node === 'object') {
    const record = node as { queryChunks?: unknown; value?: unknown; name?: unknown };
    if (Array.isArray(record.queryChunks)) {
      collectSqlParts(record.queryChunks, parts);
      return;
    }
    if (Array.isArray(record.value)) {
      collectSqlParts(record.value, parts);
      return;
    }
    if ('value' in record && (record.value == null || typeof record.value !== 'object')) {
      parts.push(String(record.value));
      return;
    }
    if (typeof record.name === 'string') {
      parts.push(record.name);
    }
  }
}

function runtimeStateSqlText(entry: Record<string, unknown>): string {
  return sqlToText(entry.runtime_state);
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
    const { db, sets, wheres } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
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
    expect(gitTokenService.getToken).toHaveBeenCalledWith(
      'installation-1',
      'standard',
      'integration-1',
      true
    );
    expect(sets).toContainEqual(
      expect.objectContaining({ auth_invalid_reason: 'github_dependabot_401' })
    );
    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(false);
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(wheres[releaseIndex]).toContain('sync_lease');
    expect(wheres[releaseIndex]).toContain("->>'runId'");
    expect(wheres[releaseIndex]).toContain('chunkIndex');
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
    expect(gitTokenService.getToken).toHaveBeenCalledWith(
      'installation-1',
      'standard',
      'integration-1',
      true
    );
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
    const { db, sets, wheres } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
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
    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(false);
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(wheres[releaseIndex]).toContain('sync_lease');
    expect(wheres[releaseIndex]).toContain("->>'runId'");
    expect(wheres[releaseIndex]).toContain('chunkIndex');
  });

  it('records disabled Dependabot alerts as a repository sync failure', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const upsertUpdates: Array<Record<string, unknown>> = [];
    const originalInsert = db.insert;
    db.insert = () => ({
      values: () => ({
        onConflictDoUpdate: async (config?: { set?: Record<string, unknown> }) => {
          if (config?.set) upsertUpdates.push(config.set);
        },
      }),
    });
    const longToken = `ghp_${'A'.repeat(250)}`;
    stubFetch(
      new Response(
        `Dependabot alerts are disabled for this repository. Authorization: bearer ${longToken}`,
        { status: 422 }
      )
    );

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
    const disabledLog = info.mock.calls.find(
      ([message]) =>
        typeof message === 'string' &&
        message.includes('Dependabot alerts disabled for acme/widgets, skipping')
    );
    expect(disabledLog?.[1]).toMatchObject({ httpStatus: 422 });
    const excerpt = (disabledLog?.[1] as { bodyExcerpt?: string } | undefined)?.bodyExcerpt ?? '';
    expect(excerpt).toContain('Dependabot alerts are disabled');
    expect(excerpt).not.toContain(longToken);
    expect(excerpt).not.toContain('ghp_');
    expect(excerpt.length).toBeLessThanOrEqual(200);
    db.insert = originalInsert;
  });

  it('redacts a bare ghp_ token in a disabled-alerts body', async () => {
    const { db } = createFakeDb();
    const gitTokenService = createGitTokenService();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const bareToken = `ghp_${'B'.repeat(250)}`;
    stubFetch(
      new Response(`Dependabot alerts are disabled for this repository. token ${bareToken}`, {
        status: 422,
      })
    );

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId: 'run-1',
      })
    ).resolves.toMatchObject({ skipped: 1 });

    const disabledLog = info.mock.calls.find(
      ([message]) =>
        typeof message === 'string' &&
        message.includes('Dependabot alerts disabled for acme/widgets, skipping')
    );
    const excerpt = (disabledLog?.[1] as { bodyExcerpt?: string } | undefined)?.bodyExcerpt ?? '';
    expect(excerpt).toContain('Dependabot alerts are disabled');
    expect(excerpt).toContain('[redacted]');
    expect(excerpt).not.toContain(bareToken);
    expect(excerpt).not.toContain('ghp_');
    expect(excerpt.length).toBeLessThanOrEqual(200);
    info.mockRestore();
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
    const { db, sets, wheres } = createFakeDb({ repositories: ['acme/widgets', 'acme/api'] });
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
    const writeIndex = sets.findIndex(entry => runtimeStateSqlText(entry).includes('jsonb_agg'));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeStateSqlText(sets[writeIndex] ?? {}).includes('sync_run')).toBe(true);
    expect(runtimeStateSqlText(sets[writeIndex] ?? {}).includes('last_synced_at')).toBe(false);
    expect(wheres[writeIndex]).toContain("->>'runId'");
    expect(wheres[writeIndex]).toContain('chunkIndex');
    expect(wheres[writeIndex]).toContain('<=');
    expect(wheres[writeIndex]).toContain('run-budget-1');
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
    const { db, sets, wheres } = createFakeDb({
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

    const freshnessIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes('last_completed_run_id')
    );
    expect(freshnessIndex).toBeGreaterThanOrEqual(0);
    expect(wheres[freshnessIndex]).toContain("->>'runId'");
    expect(wheres[freshnessIndex]).toContain('chunkIndex');
    expect(wheres[freshnessIndex]).toContain('run-budget-retry');
  });

  it('skips completed repositories and finalizes freshness on the last chunk', async () => {
    const { db, sets, wheres } = createFakeDb({
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
    const freshnessIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes('last_completed_run_id')
    );
    expect(freshnessIndex).toBeGreaterThanOrEqual(0);
    expect(wheres[freshnessIndex]).toContain("->>'runId'");
    expect(wheres[freshnessIndex]).toContain('chunkIndex');
    expect(wheres[freshnessIndex]).toContain('run-budget-1');
  });
});

describe('owner sync lease', () => {
  it('denies a claim held by another run without fetching or minting a token', async () => {
    const { db, sets, selectCount } = createFakeDb({
      repositories: ['acme/widgets'],
      claimAcquired: false,
      conflictRuntimeState: {
        sync_lease: {
          runId: 'other-run',
          chunkIndex: 0,
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      claimDenied: true,
      exhaustedBudget: false,
      holderRunId: 'other-run',
      commandResultCode: 'SYNC_ALREADY_RUNNING',
    });
    expect(result).not.toHaveProperty('staleChunk');
    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(selectCount()).toBe(0);
    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(false);
  });

  it('returns staleChunk when an older chunk of this run already holds the lease', async () => {
    const { db } = createFakeDb({
      claimAcquired: false,
      conflictRuntimeState: {
        sync_lease: {
          runId: 'run-1',
          chunkIndex: 2,
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      },
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-1',
      chunkIndex: 1,
    });

    expect(result).toMatchObject({
      staleChunk: true,
      exhaustedBudget: false,
      holderRunId: 'run-1',
    });
    expect(result).not.toHaveProperty('claimDenied');
    expect(result).not.toHaveProperty('checkpointRejected');
    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(
      info.mock.calls.some(
        ([, meta]) =>
          typeof meta === 'object' &&
          meta !== null &&
          (meta as { reason?: string }).reason === 'stale_chunk'
      )
    ).toBe(true);
    info.mockRestore();
  });

  it('treats a completed redelivery as a normal non-exhausted result', async () => {
    const { db, selectCount } = createFakeDb({
      repositories: ['acme/widgets'],
      claimAcquired: false,
      conflictRuntimeState: {
        last_completed_run_id: 'run-1',
        sync_lease: { runId: 'run-1', chunkIndex: 5 },
      },
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-1',
    });

    expect(result).not.toHaveProperty('claimDenied');
    expect(result).not.toHaveProperty('staleChunk');
    expect(result.exhaustedBudget).toBe(false);
    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(selectCount()).toBe(0);
  });

  it('returns CONFIG_DISABLED without teardown when the claim finds no owner row', async () => {
    const { db, sets } = createFakeDb({
      claimAcquired: false,
      conflictRuntimeState: null,
      configMissing: true,
    });
    const gitTokenService = createGitTokenService();

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-1',
    });

    expect(result).toMatchObject({ commandResultCode: 'CONFIG_DISABLED' });
    expect(result).not.toHaveProperty('claimDenied');
    expect(sets.some(entry => runtimeStateSqlText(entry).includes("- 'sync_lease'"))).toBe(false);
    expect(sets.some(entry => runtimeStateSqlText(entry).includes("- 'sync_run'"))).toBe(false);
  });

  it('clears then releases when a successful claim finds no enabled config', async () => {
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets'],
      configMissing: true,
    });
    const gitTokenService = createGitTokenService();

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-config-disabled',
    });

    expect(result).toMatchObject({ commandResultCode: 'CONFIG_DISABLED' });
    const clearIndex = sets.findIndex(entry => runtimeStateSqlText(entry).includes("- 'sync_run'"));
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(clearIndex);
    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(false);
  });

  it('clears then releases on the auth-invalid short-circuit after a successful claim', async () => {
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date().toISOString(),
      repositories: ['acme/widgets', 'acme/api'],
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-auth-invalid',
    });

    expect(result).toMatchObject({ authInvalid: 2, reauthRequired: true });
    expect(fetchStub).not.toHaveBeenCalled();
    const clearIndex = sets.findIndex(entry => runtimeStateSqlText(entry).includes("- 'sync_run'"));
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(clearIndex);
    expect(sets.some(entry => runtimeStateSqlText(entry).includes('last_synced_at'))).toBe(false);
  });

  it('re-claims once and throws when a vanish-race deny leaves no visible holder', async () => {
    const { db, selectCount } = createFakeDb({
      claimAcquired: false,
      conflictRuntimeState: {},
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
    ).rejects.toThrow('lost its lease holder and could not re-claim');

    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(selectCount()).toBe(0);
  });

  it('reports staleChunk without releasing when the terminal clear is owned by a newer chunk', async () => {
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date().toISOString(),
      terminalAccepted: false,
      conflictRuntimeState: { sync_lease: { runId: 'run-auth-invalid', chunkIndex: 5 } },
    });
    const gitTokenService = createGitTokenService();

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-auth-invalid',
    });

    expect(result).toMatchObject({ staleChunk: true, exhaustedBudget: false });
    expect(result).not.toHaveProperty('checkpointRejected');
    expect(sets.some(entry => runtimeStateSqlText(entry).includes("- 'sync_lease'"))).toBe(false);
  });

  it('reports checkpointRejected and releases when the terminal clear is superseded', async () => {
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date().toISOString(),
      terminalAccepted: false,
      conflictRuntimeState: { sync_lease: { runId: 'other-run', chunkIndex: 0 } },
    });
    const gitTokenService = createGitTokenService();

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-auth-invalid',
    });

    expect(result).toMatchObject({ checkpointRejected: true, exhaustedBudget: false });
    expect(result).not.toHaveProperty('staleChunk');
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
  });

  it('returns the completed result and releases when the terminal clear finds this run completed', async () => {
    const runId = 'run-completed-teardown';
    const { db, sets } = createFakeDb({
      authInvalidAt: new Date().toISOString(),
      terminalAccepted: false,
      conflictRuntimeState: { last_completed_run_id: runId },
    });
    const gitTokenService = createGitTokenService();

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId,
    });

    // Exact empty result: dropping the completed-override would instead return the
    // auth-invalid result for 'acme/widgets' (authInvalid 1, reauthRequired true).
    expect(result).toEqual({
      synced: 0,
      errors: 0,
      skipped: 0,
      authInvalid: 0,
      authInvalidRepos: [],
      reauthRequired: false,
      staleRepos: [],
      exhaustedBudget: false,
      remainingRepoCount: 0,
    });
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
  });

  it('clears and releases without a fetch when the acquired claim already completed this run', async () => {
    const runId = 'run-completed-redelivery';
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets'],
      claimRuntimeState: {
        last_completed_run_id: runId,
        sync_run: {
          runId,
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
          noProgressChunks: 0,
        },
      },
    });
    const gitTokenService = createGitTokenService();
    const fetchStub = stubFetch(new Response('unexpected'));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId,
    });

    expect(result).not.toHaveProperty('claimDenied');
    expect(result).not.toHaveProperty('staleChunk');
    expect(result.exhaustedBudget).toBe(false);
    expect(gitTokenService.getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    const clearIndex = sets.findIndex(entry => runtimeStateSqlText(entry).includes("- 'sync_run'"));
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(clearIndex);
  });

  it('throws a first-repo failure on a fresh skeleton claim that ignores a snapshot cursor', async () => {
    const runId = 'run-fresh-throw';
    const { db } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      claimRuntimeState: {
        sync_run: {
          runId,
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
          noProgressChunks: 0,
        },
      },
      runtimeState: {
        sync_run: {
          runId,
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
    const fetchStub = stubFetch(() => new Response('Service unavailable', { status: 500 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId,
      })
    ).rejects.toThrow('GitHub API error 500 for acme/widgets');

    // A snapshot cursor would skip acme/widgets and fetch once; a skeleton fetches both.
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('resumes only from the claim RETURNING and never from the returned skeleton', async () => {
    const runId = 'run-skeleton';
    const { db } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      claimRuntimeState: {
        sync_run: {
          runId,
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
          noProgressChunks: 0,
        },
      },
      runtimeState: {
        sync_run: {
          runId,
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
    const fetchStub = stubFetch(() => new Response(JSON.stringify([]), { status: 200 }));

    await expect(
      syncOwner({
        db: db as never,
        gitTokenService,
        owner: { userId: 'user-1' },
        runId,
      })
    ).resolves.toMatchObject({ exhaustedBudget: false, remainingRepoCount: 0, errors: 0 });

    // The same-runId cursor lives only on the getOwnerConfig snapshot; the claim
    // RETURNING is a skeleton. Resuming from the snapshot would skip acme/widgets
    // and fetch once. Reading only the RETURNING fetches both repos.
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('rejects a checkpoint write superseded by another run', async () => {
    const { db, selectCount } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      writeAccepted: false,
      conflictRuntimeState: { sync_lease: { runId: 'other-run', chunkIndex: 0 } },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-budget-1',
      budgetMs: 0,
    });

    expect(result).toMatchObject({ checkpointRejected: true, exhaustedBudget: false });
    expect(result).not.toHaveProperty('staleChunk');
    expect(selectCount()).toBe(3);
  });

  it('reports staleChunk when a newer chunk of this run rejects a checkpoint write', async () => {
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      writeAccepted: false,
      conflictRuntimeState: { sync_lease: { runId: 'run-budget-1', chunkIndex: 1 } },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-budget-1',
      budgetMs: 0,
    });

    expect(result).toMatchObject({ staleChunk: true, exhaustedBudget: false });
    expect(result).not.toHaveProperty('checkpointRejected');
    expect(sets.some(entry => runtimeStateSqlText(entry).includes("- 'sync_lease'"))).toBe(false);
  });

  it('releases the lease and returns the empty result when a checkpoint write finds this run completed', async () => {
    const runId = 'run-budget-1';
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      writeAccepted: false,
      conflictRuntimeState: { last_completed_run_id: runId },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId,
      budgetMs: 0,
    });

    // The completed arm always releases and overrides the partial chunk result.
    expect(result).toEqual({
      synced: 0,
      errors: 0,
      skipped: 0,
      authInvalid: 0,
      authInvalidRepos: [],
      reauthRequired: false,
      staleRepos: [],
      exhaustedBudget: false,
      remainingRepoCount: 0,
    });
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
  });

  it('reports staleChunk without releasing when freshness is rejected by a newer chunk', async () => {
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets'],
      terminalAccepted: false,
      conflictRuntimeState: { sync_lease: { runId: 'run-fresh', chunkIndex: 1 } },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-fresh',
    });

    expect(result).toMatchObject({ staleChunk: true, remainingRepoCount: 0 });
    expect(sets.some(entry => runtimeStateSqlText(entry).includes("- 'sync_lease'"))).toBe(false);
  });

  it('stops with SYNC_NO_PROGRESS at the no-progress chunk limit', async () => {
    const runId = 'run-noprogress';
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      runtimeState: {
        sync_run: {
          runId,
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
          noProgressChunks: 1,
        },
      },
    });
    const gitTokenService = createGitTokenService();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stubFetch(new Response('Service unavailable', { status: 500 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId,
      budgetMs: 0,
    });

    expect(result).toMatchObject({
      noProgress: true,
      exhaustedBudget: false,
      commandResultCode: 'SYNC_NO_PROGRESS',
    });

    const clearIndex = sets.findIndex(entry => runtimeStateSqlText(entry).includes("- 'sync_run'"));
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(clearIndex);
    expect(
      info.mock.calls.some(
        ([message, meta]) =>
          message === 'Security sync lease released' &&
          (meta as { reason?: string } | undefined)?.reason === 'no_progress'
      )
    ).toBe(true);
    expect(
      info.mock.calls.some(
        ([message]) => message === 'Security sync owner budget exhausted; continuation required'
      )
    ).toBe(false);
    info.mockRestore();
  });

  it('releases the lease and returns the empty result when the no-progress clear finds this run completed', async () => {
    const runId = 'run-noprogress-completed';
    const { db, sets } = createFakeDb({
      repositories: ['acme/widgets', 'acme/api'],
      runtimeState: {
        sync_run: {
          runId,
          completedRepos: [],
          staleRepos: [],
          authInvalidRepos: [],
          synced: 0,
          errors: 0,
          skipped: 0,
          authInvalid: 0,
          reauthRequired: false,
          noProgressChunks: 1,
        },
      },
      terminalAccepted: false,
      conflictRuntimeState: { last_completed_run_id: runId },
    });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response('Service unavailable', { status: 500 }));

    const result = await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId,
      budgetMs: 0,
    });

    // Without the completed release this arm would leave the lease held.
    expect(result).toEqual({
      synced: 0,
      errors: 0,
      skipped: 0,
      authInvalid: 0,
      authInvalidRepos: [],
      reauthRequired: false,
      staleRepos: [],
      exhaustedBudget: false,
      remainingRepoCount: 0,
    });
    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
  });

  it('binds the claim fence and skeleton in the SQL text', async () => {
    const { db, sets, wheres } = createFakeDb({ repositories: ['acme/widgets'] });
    const gitTokenService = createGitTokenService();
    stubFetch(new Response(JSON.stringify([]), { status: 200 }));

    await syncOwner({
      db: db as never,
      gitTokenService,
      owner: { userId: 'user-1' },
      runId: 'run-1',
      chunkIndex: 0,
    });

    const claimWhere = wheres[0] ?? '';
    const claimSet = runtimeStateSqlText(sets[0] ?? {});
    expect(claimWhere).toContain('jsonb_exists');
    expect(claimWhere).toContain('expiresAt');
    expect(claimWhere).toContain('sync_lease');
    expect(claimWhere).toContain('chunkIndex');
    expect(claimWhere).toContain('<=');
    expect(claimWhere).toContain('IS DISTINCT FROM');
    expect(claimSet).toContain("'chunkIndex'");
    expect(claimSet).not.toContain('"chunkIndex"');
    expect(claimSet).toContain('noProgressChunks');

    const releaseIndex = sets.findIndex(entry =>
      runtimeStateSqlText(entry).includes("- 'sync_lease'")
    );
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(wheres[releaseIndex]).toContain("->>'runId'");
    expect(wheres[releaseIndex]).toContain('<=');
    expect(wheres[releaseIndex]).not.toContain(' OR ');
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
