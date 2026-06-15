import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAutoDismissCompletedAnalysis } from './auto-dismiss.js';

describe('maybeAutoDismissCompletedAnalysis', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves Worker auto-dismiss state, Dependabot writeback, and audit trail', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [{ config: { auto_dismiss_enabled: true } }]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-123',
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'Dependency is not reachable.',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable',
          rawMarkdown: '# Not exploitable',
          analysisAt: '2026-05-18T10:00:00.000Z',
        },
      },
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.auto_dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      metadata: { correlationId: 'correlation-123', dismissSource: 'sandbox' },
    });
  });

  it('keeps automatic dismissal state and audit when upstream writeback fails', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [{ config: { auto_dismiss_enabled: true } }]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-writeback-503',
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'Dependency is not reachable.',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable',
          rawMarkdown: '# Not exploitable',
          analysisAt: '2026-05-18T10:00:00.000Z',
        },
      },
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.auto_dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      metadata: { correlationId: 'correlation-writeback-503', dismissSource: 'sandbox' },
    });
  });

  it('keeps automatic dismissal durable while skipping partially numeric Dependabot alert IDs', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [{ config: { auto_dismiss_enabled: true } }]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42junk',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-partial-source',
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'Dependency is not reachable.',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable',
          rawMarkdown: '# Not exploitable',
          analysisAt: '2026-05-18T10:00:00.000Z',
        },
      },
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.auto_dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      metadata: { correlationId: 'correlation-partial-source', dismissSource: 'sandbox' },
    });
  });

  it('keeps automatic dismissal durable while skipping malformed Dependabot repo names', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [{ config: { auto_dismiss_enabled: true } }]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo/extra',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-invalid-repo',
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'Dependency is not reachable.',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable',
          rawMarkdown: '# Not exploitable',
          analysisAt: '2026-05-18T10:00:00.000Z',
        },
      },
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.auto_dismissed',
      resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      metadata: { correlationId: 'correlation-invalid-repo', dismissSource: 'sandbox' },
    });
  });

  it('does not re-dismiss findings that are already ignored', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [{ config: { auto_dismiss_enabled: true } }]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42',
        status: 'ignored',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-already-ignored',
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'Dependency is not reachable.',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable',
          rawMarkdown: '# Not exploitable',
          analysisAt: '2026-05-18T10:00:00.000Z',
        },
      },
    });

    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('auto-dismisses high-confidence triage decisions at the configured threshold', async () => {
    let selectCount = 0;
    const updates: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1
                ? [
                    {
                      config: {
                        auto_dismiss_enabled: true,
                        auto_dismiss_confidence_threshold: 'high',
                      },
                    },
                  ]
                : [{ installationId: 'installation-123' }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
        source: 'dependabot',
        source_id: '42',
        platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        repo_full_name: 'kilo/repo',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        correlationId: 'correlation-456',
        triage: {
          needsSandboxAnalysis: false,
          needsSandboxReasoning: 'No relevant runtime path.',
          suggestedAction: 'dismiss',
          confidence: 'high',
          triageAt: '2026-05-18T09:59:00.000Z',
        },
      },
    });

    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-triage',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(auditRows[0]).toMatchObject({
      metadata: {
        correlationId: 'correlation-456',
        dismissSource: 'triage',
        confidence: 'high',
      },
    });
  });

  it('keeps low-confidence triage findings open above their confidence threshold', async () => {
    const updates: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                config: { auto_dismiss_enabled: true, auto_dismiss_confidence_threshold: 'medium' },
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    };

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {} as CloudflareEnv,
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        owned_by_user_id: null,
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        triage: {
          needsSandboxAnalysis: false,
          needsSandboxReasoning: 'Weak signal.',
          suggestedAction: 'dismiss',
          confidence: 'low',
          triageAt: '2026-05-18T09:59:00.000Z',
        },
      },
    });

    expect(updates).toHaveLength(0);
  });
});
