import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityConfigModule from '@/lib/security-agent/db/security-config';
import type * as platformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type * as dependabotApiModule from '@/lib/security-agent/github/dependabot-api';
import type * as posthogModule from '@/lib/security-agent/posthog-tracking';
import type {
  writebackDependabotDismissal as writebackDependabotDismissalType,
  maybeAutoDismissAnalysis as maybeAutoDismissAnalysisType,
  autoDismissEligibleFindings as autoDismissEligibleFindingsType,
  countEligibleForAutoDismiss as countEligibleForAutoDismissType,
} from './auto-dismiss-service';
import type { SecurityFinding } from '@kilocode/db/schema';
import { SecurityAuditLogActorType } from '@kilocode/db/schema-types';
import type { SecurityFindingAnalysis } from '../core/types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetSecurityFindingById = jest.fn() as jest.MockedFunction<
  typeof securityFindingsModule.getSecurityFindingById
>;
const mockUpdateSecurityFindingStatus = jest.fn() as jest.MockedFunction<
  typeof securityFindingsModule.updateSecurityFindingStatus
>;
const mockGetSecurityAgentConfig = jest.fn() as jest.MockedFunction<
  typeof securityConfigModule.getSecurityAgentConfig
>;
const mockGetIntegrationForOwner = jest.fn() as jest.MockedFunction<
  typeof platformIntegrationsModule.getIntegrationForOwner
>;
const mockDismissDependabotAlert = jest.fn() as jest.MockedFunction<
  typeof dependabotApiModule.dismissDependabotAlert
>;
const mockTrackAutoDismiss = jest.fn() as jest.MockedFunction<
  typeof posthogModule.trackSecurityAgentAutoDismiss
>;
let mockTransactionFinding: SecurityFinding | null = null;
const mockAuditRows: unknown[] = [];
const mockUpdatedRows: unknown[] = [];
const mockBulkFindings: Array<{ id: string; analysis: SecurityFindingAnalysis | null }> = [];

jest.mock('@/lib/security-agent/db/security-findings', () => ({
  getSecurityFindingById: mockGetSecurityFindingById,
  updateSecurityFindingStatus: mockUpdateSecurityFindingStatus,
}));

jest.mock('@/lib/security-agent/db/security-config', () => ({
  getSecurityAgentConfig: mockGetSecurityAgentConfig,
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: mockGetIntegrationForOwner,
}));

jest.mock('@/lib/security-agent/github/dependabot-api', () => ({
  dismissDependabotAlert: mockDismissDependabotAlert,
}));

jest.mock('@/lib/security-agent/posthog-tracking', () => ({
  trackSecurityAgentAutoDismiss: mockTrackAutoDismiss,
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => mockBulkFindings),
      })),
    })),
    transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              for: jest.fn(() => ({
                limit: jest.fn(async () =>
                  mockTransactionFinding ? [mockTransactionFinding] : []
                ),
              })),
            })),
          })),
        })),
        update: jest.fn(() => ({
          set: jest.fn((values: Record<string, unknown>) => ({
            where: jest.fn(() => ({
              returning: jest.fn(async () => {
                if (!mockTransactionFinding) return [];
                const updated = { ...mockTransactionFinding, ...values };
                mockTransactionFinding = updated as SecurityFinding;
                mockUpdatedRows.push(updated);
                return [updated];
              }),
            })),
          })),
        })),
        insert: jest.fn(() => ({
          values: jest.fn((values: unknown) => ({
            onConflictDoNothing: jest.fn(() => ({
              returning: jest.fn(async () => {
                mockAuditRows.push(values);
                return [{ id: 'audit-row-1' }];
              }),
            })),
          })),
        })),
      };
      return callback(tx);
    }),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

let writebackDependabotDismissal: typeof writebackDependabotDismissalType;
let maybeAutoDismissAnalysis: typeof maybeAutoDismissAnalysisType;
let autoDismissEligibleFindings: typeof autoDismissEligibleFindingsType;
let countEligibleForAutoDismiss: typeof countEligibleForAutoDismissType;

beforeAll(async () => {
  ({
    writebackDependabotDismissal,
    maybeAutoDismissAnalysis,
    autoDismissEligibleFindings,
    countEligibleForAutoDismiss,
  } = await import('./auto-dismiss-service'));
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    platform_integration_id: 'integration-1',
    repo_full_name: 'acme/repo',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    ghsa_id: 'GHSA-1234',
    cve_id: 'CVE-2024-0001',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    vulnerable_version_range: '<4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    title: 'Prototype Pollution in lodash',
    description: 'A vulnerability',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    sla_due_at: null,
    dependabot_html_url: null,
    cwe_ids: null,
    cvss_score: null,
    dependency_scope: 'runtime',
    session_id: null,
    cli_session_id: null,
    analysis_status: 'completed',
    analysis_started_at: null,
    analysis_completed_at: null,
    analysis_error: null,
    analysis: null,
    raw_data: null,
    first_detected_at: '2024-01-01T00:00:00Z',
    last_synced_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeIntegration(installationId: string) {
  return {
    platform_installation_id: installationId,
  } as NonNullable<Awaited<ReturnType<typeof platformIntegrationsModule.getIntegrationForOwner>>>;
}

const userOwner = { type: 'user' as const, id: 'user-1', userId: 'user-1' };

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockTransactionFinding = makeFinding();
  mockAuditRows.length = 0;
  mockUpdatedRows.length = 0;
  mockBulkFindings.length = 0;
});

describe('writebackDependabotDismissal', () => {
  it('dismisses a Dependabot alert on GitHub', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding());
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockResolvedValue(undefined);

    await writebackDependabotDismissal('finding-1', userOwner, 'Not exploitable');

    expect(mockDismissDependabotAlert).toHaveBeenCalledWith(
      'inst-123',
      'acme',
      'repo',
      42,
      'not_used',
      '[Kilo Code auto-dismiss] Not exploitable'
    );
  });

  it('skips non-dependabot findings', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding({ source: 'pnpm_audit' }));

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips when finding is not found', async () => {
    mockGetSecurityFindingById.mockResolvedValue(null);

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips when source_id is not a valid number', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding({ source_id: 'not-a-number' }));

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips partially numeric Dependabot alert IDs', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding({ source_id: '42junk' }));
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockResolvedValue(undefined);

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips when repo_full_name is invalid', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding({ repo_full_name: 'no-slash' }));

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips repo_full_name values with extra path segments', async () => {
    mockGetSecurityFindingById.mockResolvedValue(
      makeFinding({ repo_full_name: 'acme/repo/extra' })
    );
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockResolvedValue(undefined);

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('skips when no GitHub installation ID is available', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding());
    mockGetIntegrationForOwner.mockResolvedValue(
      makeIntegration(undefined as unknown as string) // simulate missing installation ID
    );

    await writebackDependabotDismissal('finding-1', userOwner, 'reason');

    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });
});

describe('maybeAutoDismissAnalysis', () => {
  const sandboxResult: NonNullable<SecurityFindingAnalysis['sandboxAnalysis']> = {
    isExploitable: false,
    exploitabilityReasoning:
      'The dependency is installed, but the vulnerable template function is never called.',
    usageLocations: ['package.json:17'],
    suggestedFix: 'Upgrade to latest version',
    suggestedAction: 'dismiss',
    summary: 'The vulnerable code path is not reachable.',
    rawMarkdown: 'raw',
    analysisAt: '2024-01-01T00:00:00Z',
  };
  const sandboxAnalysis: SecurityFindingAnalysis = {
    sandboxAnalysis: sandboxResult,
    analyzedAt: '2024-01-01T00:00:00Z',
  };

  const triageResult: NonNullable<SecurityFindingAnalysis['triage']> = {
    suggestedAction: 'dismiss',
    confidence: 'high',
    needsSandboxAnalysis: false,
    needsSandboxReasoning: 'Dev dependency, not exploitable',
    triageAt: '2024-01-01T00:00:00Z',
  };
  const triageAnalysis: SecurityFindingAnalysis = {
    triage: triageResult,
    analyzedAt: '2024-01-01T00:00:00Z',
  };

  it('writes back to Dependabot when auto-dismissing via sandbox', async () => {
    mockGetSecurityAgentConfig.mockResolvedValue({
      auto_dismiss_enabled: true,
      auto_dismiss_confidence_threshold: 'high',
    } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);
    mockGetSecurityFindingById.mockResolvedValue(makeFinding());
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockResolvedValue(undefined);
    mockUpdateSecurityFindingStatus.mockResolvedValue(undefined);

    const result = await maybeAutoDismissAnalysis({
      findingId: 'finding-1',
      analysis: sandboxAnalysis,
      owner: { userId: 'user-1' },
      userId: 'user-1',
    });

    expect(result).toEqual({ dismissed: true, source: 'sandbox' });
    expect(mockDismissDependabotAlert).toHaveBeenCalledWith(
      'inst-123',
      'acme',
      'repo',
      42,
      'not_used',
      expect.stringContaining('[Kilo Code auto-dismiss]')
    );
  });

  it('writes back to Dependabot when auto-dismissing via triage', async () => {
    mockGetSecurityAgentConfig.mockResolvedValue({
      auto_dismiss_enabled: true,
      auto_dismiss_confidence_threshold: 'high',
    } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);
    mockGetSecurityFindingById.mockResolvedValue(makeFinding());
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockResolvedValue(undefined);
    mockUpdateSecurityFindingStatus.mockResolvedValue(undefined);

    const result = await maybeAutoDismissAnalysis({
      findingId: 'finding-1',
      analysis: triageAnalysis,
      owner: { userId: 'user-1' },
      userId: 'user-1',
    });

    expect(result).toEqual({ dismissed: true, source: 'triage' });
    expect(mockDismissDependabotAlert).toHaveBeenCalledWith(
      'inst-123',
      'acme',
      'repo',
      42,
      'not_used',
      expect.stringContaining('[Kilo Code auto-dismiss]')
    );
  });

  it.each([
    ['exploitable', true, 'open_pr'],
    ['unknown exploitability', 'unknown', 'manual_review'],
    ['inconsistent not-exploitable result', false, 'manual_review'],
  ] as const)(
    'keeps findings open when authoritative sandbox result is %s',
    async (_label, isExploitable, suggestedAction) => {
      mockGetSecurityAgentConfig.mockResolvedValue({
        auto_dismiss_enabled: true,
        auto_dismiss_confidence_threshold: 'high',
      } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);

      const result = await maybeAutoDismissAnalysis({
        findingId: 'finding-1',
        analysis: {
          analyzedAt: '2024-01-01T00:00:00Z',
          triage: triageResult,
          sandboxAnalysis: {
            ...sandboxResult,
            isExploitable,
            suggestedAction,
          },
        },
        owner: { userId: 'user-1' },
        userId: 'user-1',
      });

      expect(result).toEqual({ dismissed: false });
      expect(mockUpdatedRows).toEqual([]);
      expect(mockAuditRows).toEqual([]);
      expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
    }
  );

  it('keeps triage findings open when triage says sandbox analysis is needed', async () => {
    mockGetSecurityAgentConfig.mockResolvedValue({
      auto_dismiss_enabled: true,
      auto_dismiss_confidence_threshold: 'high',
    } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);

    const result = await maybeAutoDismissAnalysis({
      findingId: 'finding-1',
      analysis: {
        analyzedAt: '2024-01-01T00:00:00Z',
        triage: {
          ...triageResult,
          needsSandboxAnalysis: true,
        },
      },
      owner: { userId: 'user-1' },
      userId: 'user-1',
    });

    expect(result).toEqual({ dismissed: false });
    expect(mockUpdatedRows).toEqual([]);
    expect(mockAuditRows).toEqual([]);
    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('does not write back when auto-dismiss is disabled', async () => {
    mockGetSecurityAgentConfig.mockResolvedValue({
      auto_dismiss_enabled: false,
    } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);

    const result = await maybeAutoDismissAnalysis({
      findingId: 'finding-1',
      analysis: sandboxAnalysis,
      owner: { userId: 'user-1' },
      userId: 'user-1',
    });

    expect(result).toEqual({ dismissed: false });
    expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
  });

  it('still dismisses locally even if Dependabot writeback fails', async () => {
    mockGetSecurityAgentConfig.mockResolvedValue({
      auto_dismiss_enabled: true,
      auto_dismiss_confidence_threshold: 'high',
    } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);
    mockGetSecurityFindingById.mockResolvedValue(makeFinding());
    mockGetIntegrationForOwner.mockResolvedValue(makeIntegration('inst-123'));
    mockDismissDependabotAlert.mockRejectedValue(new Error('GitHub API error'));
    mockUpdateSecurityFindingStatus.mockResolvedValue(undefined);

    const result = await maybeAutoDismissAnalysis({
      findingId: 'finding-1',
      analysis: sandboxAnalysis,
      owner: { userId: 'user-1' },
      userId: 'user-1',
    });

    // Should still succeed — writeback failure is non-fatal
    expect(result).toEqual({ dismissed: true, source: 'sandbox' });
    expect(mockUpdatedRows).toHaveLength(1);
    expect(mockUpdatedRows[0]).toMatchObject({ status: 'ignored', ignored_reason: 'not_used' });
    expect(mockAuditRows[0]).toMatchObject({
      actor_type: 'system',
      action: 'security.finding.auto_dismissed',
      finding_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      source_context: 'web',
      schema_version: 1,
    });
  });

  describe('autoDismissEligibleFindings', () => {
    it('records event-time actor and unique operation identity for bulk dismissals', async () => {
      const analysis: SecurityFindingAnalysis = {
        triage: {
          suggestedAction: 'dismiss',
          confidence: 'high',
          needsSandboxAnalysis: false,
          needsSandboxReasoning: 'No runtime path',
          triageAt: '2026-06-16T10:00:00.000Z',
        },
        analyzedAt: '2026-06-16T10:00:00.000Z',
      };
      mockBulkFindings.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', analysis });
      mockGetSecurityAgentConfig.mockResolvedValue({
        auto_dismiss_enabled: true,
        auto_dismiss_confidence_threshold: 'high',
      } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);
      mockGetSecurityFindingById.mockResolvedValue(makeFinding());
      mockGetIntegrationForOwner.mockResolvedValue(makeIntegration(undefined as unknown as string));

      await expect(
        autoDismissEligibleFindings(
          { userId: 'user-1' },
          {
            type: SecurityAuditLogActorType.CustomerUser,
            id: 'user-1',
            email: 'owner@example.com',
            name: 'Owner Example',
          }
        )
      ).resolves.toEqual({ dismissed: 1, skipped: 0, errors: 0 });

      expect(mockAuditRows).toHaveLength(1);
      expect(mockAuditRows[0]).toMatchObject({
        actor_id: 'user-1',
        actor_email: 'owner@example.com',
        actor_name: 'Owner Example',
        actor_type: 'customer_user',
        action: 'security.finding.auto_dismissed',
        finding_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        source_context: 'web',
        schema_version: 1,
        metadata: expect.objectContaining({
          trigger: 'auto_dismiss_policy',
          dismiss_source: 'bulk',
          correlation_id: expect.any(String),
        }),
      });
    });

    it('does not bulk-dismiss from triage when a sandbox result exists', async () => {
      mockBulkFindings.push({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        analysis: {
          analyzedAt: '2026-06-16T10:00:00.000Z',
          triage: triageResult,
          sandboxAnalysis: {
            ...sandboxResult,
            isExploitable: true,
            suggestedAction: 'open_pr',
          },
        },
      });
      mockGetSecurityAgentConfig.mockResolvedValue({
        auto_dismiss_enabled: true,
        auto_dismiss_confidence_threshold: 'high',
      } as Awaited<ReturnType<typeof securityConfigModule.getSecurityAgentConfig>>);

      await expect(
        autoDismissEligibleFindings(
          { userId: 'user-1' },
          {
            type: SecurityAuditLogActorType.CustomerUser,
            id: 'user-1',
            email: 'owner@example.com',
            name: 'Owner Example',
          }
        )
      ).resolves.toEqual({ dismissed: 0, skipped: 1, errors: 0 });

      expect(mockUpdatedRows).toEqual([]);
      expect(mockAuditRows).toEqual([]);
      expect(mockDismissDependabotAlert).not.toHaveBeenCalled();
    });

    it('excludes sandbox-analyzed findings from triage-only eligibility counts', async () => {
      mockBulkFindings.push(
        {
          id: 'triage-only',
          analysis: {
            analyzedAt: '2026-06-16T10:00:00.000Z',
            triage: triageResult,
          },
        },
        {
          id: 'sandbox-completed',
          analysis: {
            analyzedAt: '2026-06-16T10:00:00.000Z',
            triage: triageResult,
            sandboxAnalysis: {
              ...sandboxResult,
              isExploitable: true,
              suggestedAction: 'open_pr',
            },
          },
        }
      );

      await expect(countEligibleForAutoDismiss({ userId: 'user-1' }, 'user-1')).resolves.toEqual({
        eligible: 1,
        byConfidence: { high: 1, medium: 0, low: 0 },
      });
    });

    it('excludes malformed triage confidence from eligibility counts', async () => {
      mockBulkFindings.push({
        id: 'malformed-confidence',
        analysis: {
          analyzedAt: '2026-06-16T10:00:00.000Z',
          triage: {
            ...triageResult,
            confidence: 'certain',
          },
        } as unknown as SecurityFindingAnalysis,
      });

      await expect(countEligibleForAutoDismiss({ userId: 'user-1' }, 'user-1')).resolves.toEqual({
        eligible: 0,
        byConfidence: { high: 0, medium: 0, low: 0 },
      });
    });
  });
});
