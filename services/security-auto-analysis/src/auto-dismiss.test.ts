import type { SecurityFinding } from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import { SECURITY_FINDING_AUDIT_SCHEMA_VERSION } from '@kilocode/worker-utils/security-finding-audit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeAutoDismissCompletedAnalysis } from './auto-dismiss.js';
import type { SecurityFindingAnalysis } from './types.js';

const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTEGRATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: FINDING_ID,
    owned_by_organization_id: ORGANIZATION_ID,
    owned_by_user_id: null,
    platform_integration_id: INTEGRATION_ID,
    repo_full_name: 'kilo/repo',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    ghsa_id: 'GHSA-1234-5678',
    cve_id: 'CVE-2026-1234',
    package_name: 'example-package',
    package_ecosystem: 'npm',
    vulnerable_version_range: '<2.0.0',
    patched_version: '2.0.0',
    manifest_path: 'package.json',
    title: 'Example vulnerability',
    description: 'Example description',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    sla_due_at: null,
    dependabot_html_url: 'https://github.com/kilo/repo/security/dependabot/42',
    cwe_ids: ['CWE-79'],
    cvss_score: '7.5',
    dependency_scope: 'runtime',
    session_id: 'agent-session',
    cli_session_id: 'kilo-session',
    analysis_status: 'completed',
    analysis_started_at: '2026-05-18T09:55:00.000Z',
    analysis_completed_at: '2026-05-18T10:00:00.000Z',
    analysis_error: null,
    analysis: null,
    raw_data: null,
    first_detected_at: '2026-05-17T10:00:00.000Z',
    last_synced_at: '2026-05-18T09:00:00.000Z',
    created_at: '2026-05-17T10:00:00.000Z',
    updated_at: '2026-05-18T10:00:00.000Z',
    ...overrides,
  };
}

function sandboxAnalysis(
  correlationId: string,
  overrides: Partial<NonNullable<SecurityFindingAnalysis['sandboxAnalysis']>> = {}
): SecurityFindingAnalysis {
  return {
    analyzedAt: '2026-05-18T10:00:00.000Z',
    correlationId,
    sandboxAnalysis: {
      isExploitable: false,
      exploitabilityReasoning:
        'The dependency is installed, but the vulnerable template function is never called.',
      usageLocations: ['package.json:17'],
      suggestedFix: 'Upgrade',
      suggestedAction: 'dismiss',
      summary: 'The vulnerable code path is not reachable.',
      rawMarkdown: '# Not exploitable',
      analysisAt: '2026-05-18T10:00:00.000Z',
      ...overrides,
    },
  };
}

function createDbHarness(
  options: {
    finding?: SecurityFinding;
    config?: Record<string, unknown>;
    installationId?: string;
    auditError?: Error;
  } = {}
) {
  const state = {
    finding: options.finding ?? makeFinding(),
    auditRows: [] as Array<Record<string, unknown>>,
    committedUpdates: [] as Array<Record<string, unknown>>,
    transactionCalls: 0,
  };
  let rootSelectCount = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            rootSelectCount += 1;
            return rootSelectCount === 1
              ? [
                  {
                    config: options.config ?? {
                      auto_dismiss_enabled: true,
                      auto_dismiss_confidence_threshold: 'high',
                    },
                  },
                ]
              : [{ installationId: options.installationId ?? 'installation-123' }];
          },
        }),
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      state.transactionCalls += 1;
      let stagedFinding = state.finding;
      const stagedAuditRows: Array<Record<string, unknown>> = [];
      const stagedUpdates: Array<Record<string, unknown>> = [];
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => [stagedFinding] }),
            }),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => ({
              returning: async () => {
                const updatedFinding = { ...stagedFinding, ...values } as SecurityFinding;
                stagedFinding = updatedFinding;
                stagedUpdates.push(values);
                return [updatedFinding];
              },
            }),
          }),
        }),
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                if (options.auditError) throw options.auditError;
                stagedAuditRows.push(values);
                return [{ id: 'audit-row-1' }];
              },
            }),
          }),
        }),
      };

      const result = await callback(tx);
      state.finding = stagedFinding;
      state.auditRows.push(...stagedAuditRows);
      state.committedUpdates.push(...stagedUpdates);
      return result;
    },
  };

  return { db, state };
}

describe('maybeAutoDismissCompletedAnalysis', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('commits sandbox dismissal with canonical current audit evidence before writeback', async () => {
    const { db, state } = createDbHarness();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: FINDING_ID,
      finding: makeFinding() as never,
      analysis: sandboxAnalysis('correlation-123'),
    });

    expect(state.finding).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
    });
    expect(state.auditRows).toHaveLength(1);
    expect(state.auditRows[0]).toMatchObject({
      action: SecurityAuditLogAction.FindingAutoDismissed,
      finding_id: FINDING_ID,
      resource_type: 'security_finding',
      resource_id: FINDING_ID,
      occurred_at: expect.any(String),
      event_key: expect.stringContaining('correlation-123'),
      schema_version: SECURITY_FINDING_AUDIT_SCHEMA_VERSION,
      source_context: SecurityFindingAuditSourceContext.AnalysisWorker,
      before_state: { status: 'open' },
      after_state: { status: 'ignored', reason_code: 'not_used' },
      metadata: {
        reason_code: 'not_used',
        trigger: 'auto_dismiss_policy',
        dismiss_source: 'sandbox',
        correlation_id: 'correlation-123',
      },
      finding_snapshot: expect.objectContaining({
        finding_id: FINDING_ID,
        status: 'ignored',
        repo_full_name: 'kilo/repo',
      }),
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/dependabot/alerts/42'),
      expect.objectContaining({
        body: JSON.stringify({
          state: 'dismissed',
          dismissed_reason: 'not_used',
          dismissed_comment:
            '[Kilo Code auto-dismiss] The dependency is installed, but the vulnerable template function is never called.',
        }),
      })
    );
  });

  it('keeps canonical local dismissal when upstream writeback fails', async () => {
    const { db, state } = createDbHarness();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: FINDING_ID,
      finding: makeFinding() as never,
      analysis: sandboxAnalysis('correlation-writeback-503'),
    });

    expect(state.finding.status).toBe('ignored');
    expect(state.auditRows).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['partially numeric alert ID', { source_id: '42junk' }],
    ['malformed repository name', { repo_full_name: 'kilo/repo/extra' }],
  ])('keeps local dismissal while skipping %s', async (_label, findingOverrides) => {
    const finding = makeFinding(findingOverrides);
    const { db, state } = createDbHarness({ finding });
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: FINDING_ID,
      finding: finding as never,
      analysis: sandboxAnalysis('correlation-invalid-target'),
    });

    expect(state.finding.status).toBe('ignored');
    expect(state.auditRows).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not re-dismiss findings that are already ignored', async () => {
    const finding = makeFinding({ status: 'ignored' });
    const { db, state } = createDbHarness({ finding });
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: FINDING_ID,
      finding: finding as never,
      analysis: sandboxAnalysis('correlation-already-ignored'),
    });

    expect(state.committedUpdates).toHaveLength(0);
    expect(state.auditRows).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records configured high-confidence triage dismissal as current evidence', async () => {
    const { db, state } = createDbHarness();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const analysis: SecurityFindingAnalysis = {
      analyzedAt: '2026-05-18T10:00:00.000Z',
      correlationId: 'correlation-456',
      triage: {
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'No relevant runtime path.',
        suggestedAction: 'dismiss',
        confidence: 'high',
        triageAt: '2026-05-18T09:59:00.000Z',
      },
    };

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {
        GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
      } as unknown as CloudflareEnv,
      findingId: FINDING_ID,
      finding: makeFinding() as never,
      analysis,
    });

    expect(state.finding).toMatchObject({ status: 'ignored', ignored_by: 'auto-triage' });
    expect(state.auditRows[0]).toMatchObject({
      source_context: SecurityFindingAuditSourceContext.AnalysisWorker,
      metadata: {
        reason_code: 'not_used',
        trigger: 'auto_dismiss_policy',
        dismiss_source: 'triage',
        confidence: 'high',
        correlation_id: 'correlation-456',
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['exploitable', true, 'open_pr'],
    ['unknown exploitability', 'unknown', 'manual_review'],
    ['inconsistent not-exploitable result', false, 'manual_review'],
  ] as const)(
    'keeps findings open when authoritative sandbox result is %s',
    async (_label, isExploitable, suggestedAction) => {
      const { db, state } = createDbHarness();
      const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const analysis = sandboxAnalysis('correlation-authoritative-sandbox', {
        isExploitable,
        suggestedAction,
      });
      analysis.triage = {
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Earlier triage recommended dismissal.',
        suggestedAction: 'dismiss',
        confidence: 'high',
        triageAt: '2026-05-18T09:59:00.000Z',
      };

      await maybeAutoDismissCompletedAnalysis({
        db: db as never,
        env: {
          GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
        } as unknown as CloudflareEnv,
        findingId: FINDING_ID,
        finding: makeFinding() as never,
        analysis,
      });

      expect(state.transactionCalls).toBe(0);
      expect(state.finding.status).toBe('open');
      expect(state.auditRows).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('keeps triage findings open when triage says sandbox analysis is needed', async () => {
    const { db, state } = createDbHarness();

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {} as CloudflareEnv,
      findingId: FINDING_ID,
      finding: makeFinding() as never,
      analysis: {
        analyzedAt: '2026-05-18T10:00:00.000Z',
        triage: {
          needsSandboxAnalysis: true,
          needsSandboxReasoning: 'Codebase usage must be checked.',
          suggestedAction: 'dismiss',
          confidence: 'high',
          triageAt: '2026-05-18T09:59:00.000Z',
        },
      },
    });

    expect(state.transactionCalls).toBe(0);
    expect(state.finding.status).toBe('open');
    expect(state.auditRows).toEqual([]);
  });

  it('keeps low-confidence triage findings open above configured threshold', async () => {
    const { db, state } = createDbHarness({
      config: {
        auto_dismiss_enabled: true,
        auto_dismiss_confidence_threshold: 'medium',
      },
    });

    await maybeAutoDismissCompletedAnalysis({
      db: db as never,
      env: {} as CloudflareEnv,
      findingId: FINDING_ID,
      finding: makeFinding() as never,
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

    expect(state.transactionCalls).toBe(0);
    expect(state.finding.status).toBe('open');
    expect(state.auditRows).toEqual([]);
  });

  it('rolls back local dismissal when canonical audit insertion fails', async () => {
    const { db, state } = createDbHarness({ auditError: new Error('audit insert failed') });
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      maybeAutoDismissCompletedAnalysis({
        db: db as never,
        env: {
          GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
        } as unknown as CloudflareEnv,
        findingId: FINDING_ID,
        finding: makeFinding() as never,
        analysis: sandboxAnalysis('correlation-rollback'),
      })
    ).rejects.toThrow('audit insert failed');

    expect(state.finding.status).toBe('open');
    expect(state.auditRows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails before dismissing when audit identity is missing from malformed analysis', async () => {
    const { db, state } = createDbHarness();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      maybeAutoDismissCompletedAnalysis({
        db: db as never,
        env: {
          GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
        } as unknown as CloudflareEnv,
        findingId: FINDING_ID,
        finding: makeFinding() as never,
        analysis: {
          sandboxAnalysis: {
            isExploitable: false,
            exploitabilityReasoning: 'No reachable vulnerable code path.',
            usageLocations: [],
            suggestedFix: 'No fix required.',
            suggestedAction: 'dismiss',
            summary: 'Not exploitable.',
            rawMarkdown: '# Not exploitable',
          },
        } as unknown as SecurityFindingAnalysis,
      })
    ).rejects.toThrow('Auto-dismiss audit event requires an analysis identity');

    expect(state.transactionCalls).toBe(0);
    expect(state.finding.status).toBe('open');
    expect(state.auditRows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
