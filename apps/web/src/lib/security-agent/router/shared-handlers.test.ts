import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { createSecurityAgentHandlers as createSecurityAgentHandlersType } from './shared-handlers';
import type * as manualSyncClientModule from '../services/manual-sync-client';
import type * as manualDismissClientModule from '../services/manual-dismiss-client';
import type * as manualAnalysisClientModule from '../services/manual-analysis-client';
import type * as manualRemediationClientModule from '../services/manual-remediation-client';
import type { OperationLedgerRow } from '@kilocode/db/schema';

const commandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const mockSubmitManualSecuritySync = jest.fn() as jest.MockedFunction<
  typeof manualSyncClientModule.submitManualSecuritySync
>;
const mockSubmitManualFindingDismissal = jest.fn() as jest.MockedFunction<
  typeof manualDismissClientModule.submitManualFindingDismissal
>;
const mockSubmitManualAnalysisStart = jest.fn() as jest.MockedFunction<
  typeof manualAnalysisClientModule.submitManualAnalysisStart
>;
const mockSubmitApplyAutoRemediation = jest.fn() as jest.MockedFunction<
  typeof manualRemediationClientModule.submitApplyAutoRemediation
>;
const mockSubmitManualRemediationStart = jest.fn() as jest.MockedFunction<
  typeof manualRemediationClientModule.submitManualRemediationStart
>;
const mockSubmitRemediationCancellation = jest.fn() as jest.MockedFunction<
  typeof manualRemediationClientModule.submitRemediationCancellation
>;
const mockGetSecurityFindingById = jest.fn<() => Promise<unknown>>();
const mockCanStartAnalysis = jest.fn<(owner: unknown) => Promise<unknown>>();
const mockEnqueueBacklogFindings = jest.fn<() => Promise<number>>();
const mockGetSecurityAgentConfigWithStatus = jest.fn<() => Promise<unknown>>();
const mockDecorateFindingWithRemediation = jest.fn<() => Promise<unknown>>();
const mockDecorateFindingsWithRemediation = jest.fn<() => Promise<unknown>>();
const mockGetRemediationAttemptHistory = jest.fn<() => Promise<unknown>>();
const mockDeleteFindingsByRepository =
  jest.fn<(params: unknown) => Promise<{ deletedCount: number }>>();
const mockTrackSecurityAgentSync = jest.fn();
const mockTrackSecurityAgentUiInteraction = jest.fn();
const mockTrackSecurityAgentRemediationAction = jest.fn();
const mockLogSecurityAudit = jest.fn();
const mockCreateSecurityAuditLog = jest.fn();
const mockUpsertSecurityAgentConfig = jest.fn();
const mockSetSecurityAgentEnabled = jest.fn();
const mockCheckDependabotAlertsAvailability =
  jest.fn<
    (installationId: string, appType: string, repositories: unknown[]) => Promise<unknown[]>
  >();
const mockAutoDismissEligibleFindings =
  jest.fn<
    (
      owner: unknown,
      actor: unknown
    ) => Promise<{ dismissed: number; skipped: number; errors: number }>
  >();
const mockAdmitOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMarkReconcilePending = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRecordOperationAcceptance = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSettleOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../services/manual-sync-client', () => ({
  submitManualSecuritySync: mockSubmitManualSecuritySync,
}));
jest.mock('../services/manual-dismiss-client', () => ({
  submitManualFindingDismissal: mockSubmitManualFindingDismissal,
}));
jest.mock('../services/manual-analysis-client', () => ({
  submitManualAnalysisStart: mockSubmitManualAnalysisStart,
}));
jest.mock('../services/manual-remediation-client', () => ({
  submitApplyAutoRemediation: mockSubmitApplyAutoRemediation,
  submitManualRemediationStart: mockSubmitManualRemediationStart,
  submitRemediationCancellation: mockSubmitRemediationCancellation,
}));
jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mockAdmitOperation,
  markReconcilePending: mockMarkReconcilePending,
  recordOperationAcceptance: mockRecordOperationAcceptance,
  settleOperation: mockSettleOperation,
}));
jest.mock('../github/permissions', () => ({
  hasSecurityReviewPermissions: () => true,
  getReauthorizeUrl: jest.fn(),
}));
jest.mock('../github/dependabot-api', () => ({
  checkDependabotAlertsAvailability: mockCheckDependabotAlertsAvailability,
}));
jest.mock('../posthog-tracking', () => ({
  trackSecurityAgentEnabled: jest.fn(),
  trackSecurityAgentConfigSaved: jest.fn(),
  trackSecurityAgentSync: mockTrackSecurityAgentSync,
  trackSecurityAgentFindingDismissed: jest.fn(),
  trackSecurityAgentUiInteraction: mockTrackSecurityAgentUiInteraction,
  trackSecurityAgentRemediationAction: mockTrackSecurityAgentRemediationAction,
}));
jest.mock('../services/audit-log-service', () => ({
  createSecurityAuditLog: mockCreateSecurityAuditLog,
  logSecurityAudit: mockLogSecurityAudit,
  SecurityAuditLogAction: {
    ConfigEnabled: 'config_enabled',
    ConfigDisabled: 'config_disabled',
    ConfigUpdated: 'config_updated',
    SyncTriggered: 'sync_triggered',
    FindingDismissed: 'finding_dismissed',
  },
}));
jest.mock('../db/security-config', () => ({
  getSecurityAgentConfigWithStatus: mockGetSecurityAgentConfigWithStatus,
  upsertSecurityAgentConfig: mockUpsertSecurityAgentConfig,
  setSecurityAgentEnabled: mockSetSecurityAgentEnabled,
}));
jest.mock('../db/security-findings', () => ({
  listSecurityFindings: jest.fn(),
  getSecurityFindingById: mockGetSecurityFindingById,
  getSecurityFindingsSummary: jest.fn(),
  getLastSyncTime: jest.fn(),
  getOrphanedRepositoriesWithFindingCounts: jest.fn(),
  deleteFindingsByRepository: mockDeleteFindingsByRepository,
}));
jest.mock('../db/security-remediation', () => ({
  decorateFindingWithRemediation: mockDecorateFindingWithRemediation,
  decorateFindingsWithRemediation: mockDecorateFindingsWithRemediation,
  getRemediationAttemptHistory: mockGetRemediationAttemptHistory,
}));
jest.mock('../db/security-commands', () => ({
  getSecurityAgentCommandStatus: jest.fn(),
  listActiveSecurityAgentCommands: jest.fn(),
}));
jest.mock('../db/dashboard-stats', () => ({ getDashboardStats: jest.fn() }));
jest.mock('../db/security-analysis', () => ({
  canStartAnalysis: mockCanStartAnalysis,
  enqueueBacklogFindings: mockEnqueueBacklogFindings,
}));
jest.mock('../services/auto-dismiss-service', () => ({
  autoDismissEligibleFindings: mockAutoDismissEligibleFindings,
  countEligibleForAutoDismiss: jest.fn(),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  updateRepositoriesForIntegration: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubRepositories: jest.fn(),
}));

let createSecurityAgentHandlers: typeof createSecurityAgentHandlersType;

beforeAll(async () => {
  ({ createSecurityAgentHandlers } = await import('./shared-handlers'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecurityAgentConfigWithStatus.mockResolvedValue(null);
  mockGetRemediationAttemptHistory.mockResolvedValue([]);
  mockEnqueueBacklogFindings.mockResolvedValue(0);
  mockCheckDependabotAlertsAvailability.mockResolvedValue([]);
  mockRecordOperationAcceptance.mockResolvedValue({ status: 'admitted' });
  mockMarkReconcilePending.mockResolvedValue({ status: 'reconcile_pending' });
  mockSettleOperation.mockResolvedValue({ settled: true });
});

function createHandlers() {
  return createSecurityAgentHandlers({
    resolveOwner: () => ({
      type: 'org',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'user-123',
    }),
    resolveSecurityOwner: () => ({ organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    resolveResourceId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    verifyFindingOwnership: () => true,
    getIntegration: async () =>
      ({
        id: 'integration-123',
        integration_status: 'active',
        platform_installation_id: 'installation-123',
        repositories: [{ id: 1, full_name: 'kilo/repo', name: 'repo', private: true }],
      }) as never,
    trackingExtras: () => ({}),
  });
}

function createPersonalHandlers() {
  return createSecurityAgentHandlers({
    resolveOwner: () => ({ type: 'user', id: 'user-123', userId: 'user-123' }),
    resolveSecurityOwner: () => ({ userId: 'user-123' }),
    resolveResourceId: () => 'user-123',
    verifyFindingOwnership: () => true,
    getIntegration: async () =>
      ({
        id: 'integration-123',
        integration_status: 'active',
        platform_installation_id: 'installation-123',
        repositories: [],
      }) as never,
    trackingExtras: () => ({}),
  });
}

function createOrganizationTrackingHandlers() {
  return createSecurityAgentHandlers<{ organizationId: string }>({
    resolveOwner: (ctx, input) => ({
      type: 'org',
      id: input.organizationId,
      userId: ctx.user.id,
    }),
    resolveSecurityOwner: (_ctx, input) => ({ organizationId: input.organizationId }),
    resolveResourceId: (_ctx, input) => input.organizationId,
    verifyFindingOwnership: (finding, _ctx, input) =>
      finding.owned_by_organization_id === input.organizationId,
    getIntegration: async () =>
      ({
        id: 'integration-123',
        integration_status: 'active',
        platform_installation_id: 'installation-123',
        repositories: [],
      }) as never,
    trackingExtras: (_ctx, input) => ({ organizationId: input.organizationId }),
  });
}

const context = {
  user: {
    id: 'user-123',
    google_user_email: 'owner@example.com',
    google_user_name: 'Owner Example',
    is_admin: false,
  },
} as never;

describe('trackUiInteraction', () => {
  it('tracks an allowlisted interaction with authenticated personal identity', async () => {
    await expect(
      createPersonalHandlers().trackUiInteraction.handler({
        ctx: context,
        input: { interaction: 'finding_detail_opened' },
      })
    ).resolves.toEqual({ success: true });

    expect(mockTrackSecurityAgentUiInteraction).toHaveBeenCalledWith({
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: undefined,
      interaction: 'finding_detail_opened',
    });
  });

  it('uses trusted organization context from the router input', async () => {
    await createOrganizationTrackingHandlers().trackUiInteraction.handler({
      ctx: context,
      input: {
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        interaction: 'settings_automation_viewed',
      },
    });

    expect(mockTrackSecurityAgentUiInteraction).toHaveBeenCalledWith({
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      interaction: 'settings_automation_viewed',
    });
  });

  it('rejects unsupported interaction values at the schema boundary', () => {
    expect(
      createPersonalHandlers().trackUiInteraction.inputSchema.safeParse({
        interaction: 'finding_exported',
      }).success
    ).toBe(false);
  });

  it('does not write UI interactions to database or audit storage', async () => {
    await createPersonalHandlers().trackUiInteraction.handler({
      ctx: context,
      input: { interaction: 'findings_filtered' },
    });

    expect(mockUpsertSecurityAgentConfig).not.toHaveBeenCalled();
    expect(mockSetSecurityAgentEnabled).not.toHaveBeenCalled();
    expect(mockCreateSecurityAuditLog).not.toHaveBeenCalled();
    expect(mockLogSecurityAudit).not.toHaveBeenCalled();
  });
});

describe('getRepositories', () => {
  it('includes Dependabot alerts availability for each repository', async () => {
    mockCheckDependabotAlertsAvailability.mockResolvedValueOnce([{ id: 1, status: 'disabled' }]);

    await expect(createHandlers().getRepositories({ ctx: context, input: {} })).resolves.toEqual([
      {
        id: 1,
        fullName: 'kilo/repo',
        name: 'repo',
        private: true,
        dependabotAlerts: 'disabled',
      },
    ]);

    expect(mockCheckDependabotAlertsAvailability).toHaveBeenCalledWith(
      'installation-123',
      'standard',
      [
        {
          id: 1,
          fullName: 'kilo/repo',
          name: 'repo',
          private: true,
        },
      ]
    );
  });

  it('keeps repository selection available when the availability check fails', async () => {
    mockCheckDependabotAlertsAvailability.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(createHandlers().getRepositories({ ctx: context, input: {} })).resolves.toEqual([
      expect.objectContaining({ id: 1, dependabotAlerts: 'unknown' }),
    ]);
  });
});

describe('getConfig', () => {
  it('marks new owners without config as setup state', async () => {
    await expect(createHandlers().getConfig({ ctx: context, input: {} })).resolves.toMatchObject({
      hasConfig: false,
      isEnabled: false,
    });
  });

  it('marks existing disabled config as configured', async () => {
    mockGetSecurityAgentConfigWithStatus.mockResolvedValue({
      isEnabled: false,
      storedConfig: {},
      config: {
        sla_critical_days: 15,
        sla_high_days: 30,
        sla_medium_days: 45,
        sla_low_days: 90,
        sla_enabled: true,
        auto_sync_enabled: true,
        repository_selection_mode: 'selected',
        selected_repository_ids: [],
        model_slug: 'analysis-model',
        triage_model_slug: 'triage-model',
        analysis_model_slug: 'analysis-model',
        analysis_mode: 'auto',
        auto_dismiss_enabled: false,
        auto_dismiss_confidence_threshold: 'high',
        auto_analysis_enabled: false,
        auto_analysis_min_severity: 'high',
        auto_analysis_include_existing: false,
        auto_remediation_enabled: false,
        auto_remediation_min_severity: 'high',
        auto_remediation_include_existing: false,
        auto_remediation_enabled_at: null,
        remediation_model_slug: 'remediation-model',
        sla_notifications_enabled: false,
        sla_notification_min_severity: 'high',
        sla_notification_warning_days: 3,
        new_finding_notifications_enabled: false,
        new_finding_notification_min_severity: 'high',
      },
    });

    await expect(createHandlers().getConfig({ ctx: context, input: {} })).resolves.toMatchObject({
      hasConfig: true,
      isEnabled: false,
    });
  });
});

describe('setEnabled', () => {
  it('returns initial sync command correlation after enable', async () => {
    mockSubmitManualSecuritySync.mockResolvedValue({
      accepted: true,
      commandId,
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      messageId: 'enable-sync-message-123',
    });

    await expect(
      createHandlers().setEnabled.handler({
        ctx: context,
        input: { isEnabled: true, repositorySelectionMode: 'all', selectedRepositoryIds: [] },
      })
    ).resolves.toEqual({
      success: true,
      initialSync: {
        accepted: true,
        commandId,
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        messageId: 'enable-sync-message-123',
      },
      initialSyncAdmissionFailed: false,
    });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'enable_initial_sync' })
    );
  });

  it('reports partial success when initial sync admission fails after enable', async () => {
    mockSubmitManualSecuritySync.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      createHandlers().setEnabled.handler({
        ctx: context,
        input: { isEnabled: true, repositorySelectionMode: 'all', selectedRepositoryIds: [] },
      })
    ).resolves.toEqual({
      success: true,
      initialSync: undefined,
      initialSyncAdmissionFailed: true,
    });
  });
});

describe('saveConfig', () => {
  it('awaits existing-finding backlog admission and returns queued count', async () => {
    mockEnqueueBacklogFindings.mockResolvedValue(4);

    await expect(
      createHandlers().saveConfig.handler({
        ctx: context,
        input: { autoAnalysisEnabled: true, autoAnalysisIncludeExisting: true },
      })
    ).resolves.toMatchObject({ success: true, existingFindingsQueuedCount: 4 });
  });

  it('keeps saved settings authoritative when backlog admission fails', async () => {
    mockEnqueueBacklogFindings.mockRejectedValue(new Error('database unavailable'));

    await expect(
      createHandlers().saveConfig.handler({
        ctx: context,
        input: { autoAnalysisEnabled: true, autoAnalysisIncludeExisting: true },
      })
    ).resolves.toMatchObject({
      success: true,
      backlogAdmissionWarning: expect.stringContaining('Settings saved'),
    });
  });
});

describe('autoDismissEligible', () => {
  it('attributes per-finding bulk dismissal events without writing aggregate finding activity', async () => {
    mockAutoDismissEligibleFindings.mockResolvedValue({ dismissed: 2, skipped: 1, errors: 0 });

    await expect(
      createHandlers().autoDismissEligible({ ctx: context, input: {} })
    ).resolves.toEqual({ dismissed: 2, skipped: 1, errors: 0 });

    expect(mockAutoDismissEligibleFindings).toHaveBeenCalledWith(
      { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      {
        type: 'customer_user',
        id: 'user-123',
        email: 'owner@example.com',
        name: 'Owner Example',
      }
    );
    expect(mockLogSecurityAudit).not.toHaveBeenCalled();
  });
});

describe('deleteFindingsByRepository', () => {
  it('propagates authoritative admin classification to deletion events', async () => {
    mockDeleteFindingsByRepository.mockResolvedValue({ deletedCount: 2 });
    const adminContext = {
      user: {
        id: 'user-123',
        google_user_email: 'operator@example.com',
        google_user_name: 'Owner Example',
        is_admin: true,
      },
    } as never;

    await expect(
      createHandlers().deleteFindingsByRepository.handler({
        ctx: adminContext,
        input: { repoFullName: 'kilo/repo' },
      })
    ).resolves.toEqual({ success: true, deletedCount: 2 });

    expect(mockDeleteFindingsByRepository).toHaveBeenCalledWith({
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      repoFullName: 'kilo/repo',
      actor: {
        type: 'kilo_admin',
        id: 'user-123',
        email: 'operator@example.com',
        name: 'Owner Example',
      },
    });
  });
});

describe('getAnalysis', () => {
  it('returns current finding state with analysis and remediation data', async () => {
    const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const finding = {
      id: findingId,
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-sandbox',
      updated_at: '2026-06-17T11:45:00.000Z',
      analysis_status: 'completed',
      analysis_started_at: '2026-06-17T11:40:00.000Z',
      analysis_completed_at: '2026-06-17T11:44:59.000Z',
      analysis_error: null,
      analysis: { analyzedAt: '2026-06-17T11:44:59.000Z' },
      session_id: 'session-123',
      cli_session_id: 'cli-session-123',
    };
    const decoratedFinding = {
      ...finding,
      remediationSummary: null,
      remediationCapability: {
        canStart: false,
        startReason: 'finding_not_open',
        canRetry: false,
        retryReason: 'finding_not_open',
        canCancel: false,
        cancelAttemptId: null,
      },
    };
    mockGetSecurityFindingById.mockResolvedValue(finding);
    mockDecorateFindingWithRemediation.mockResolvedValue(decoratedFinding);

    await expect(
      createHandlers().getAnalysis.handler({ ctx: context, input: { findingId } })
    ).resolves.toMatchObject({
      findingState: {
        status: 'ignored',
        ignoredReason: 'not_used',
        ignoredBy: 'auto-sandbox',
        updatedAt: '2026-06-17T11:45:00.000Z',
      },
      status: 'completed',
      remediationCapability: { startReason: 'finding_not_open' },
    });
  });
});

describe('queue-backed handlers', () => {
  it('returns sync command correlation', async () => {
    mockSubmitManualSecuritySync.mockResolvedValue({
      accepted: true,
      commandId,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      messageId: 'message-123',
    });

    await expect(
      createHandlers().triggerSync.handler({ ctx: context, input: { repoFullName: 'kilo/repo' } })
    ).resolves.toMatchObject({ success: true, accepted: true, commandId });
  });

  it('returns dismissal command correlation', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: 'finding-id', source: 'dependabot' });
    mockSubmitManualFindingDismissal.mockResolvedValue({
      accepted: true,
      commandId,
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dismiss-message-123',
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: {
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          reason: 'not_used',
        },
      })
    ).resolves.toMatchObject({ success: true, accepted: true, commandId });
    expect(mockSubmitManualFindingDismissal).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: 'user-123' } })
    );
  });

  it('returns manual analysis command correlation', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: 'finding-id' });
    mockCanStartAnalysis.mockResolvedValue({ allowed: true, currentCount: 0, limit: 3 });
    mockSubmitManualAnalysisStart.mockResolvedValue({ queued: true, commandId });

    await expect(
      createHandlers().startAnalysis.handler({
        ctx: context,
        input: { findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      })
    ).resolves.toEqual({ success: true, queued: true, commandId });

    expect(mockCanStartAnalysis).toHaveBeenCalledWith({
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });

  it('bypasses owner capacity only for a validated active restart', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: 'finding-id',
      analysis_status: 'running',
    });
    mockCanStartAnalysis.mockResolvedValue({ allowed: false, currentCount: 3, limit: 3 });
    mockSubmitManualAnalysisStart.mockResolvedValue({ queued: true, commandId });

    await expect(
      createHandlers().startAnalysis.handler({
        ctx: context,
        input: {
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          restartActive: true,
        },
      })
    ).resolves.toEqual({ success: true, queued: true, commandId });

    expect(mockCanStartAnalysis).not.toHaveBeenCalled();
    expect(mockSubmitManualAnalysisStart).toHaveBeenCalledWith(
      expect.objectContaining({ restartActive: true })
    );
  });

  it('rejects active restart requests after finding is no longer running', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: 'finding-id',
      analysis_status: 'completed',
    });

    await expect(
      createHandlers().startAnalysis.handler({
        ctx: context,
        input: {
          findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          restartActive: true,
        },
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Only a running Sandbox Analysis can be restarted',
    });

    expect(mockCanStartAnalysis).not.toHaveBeenCalled();
    expect(mockSubmitManualAnalysisStart).not.toHaveBeenCalled();
  });
});

describe('security operation ledger (P1-A-08e)', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const commandId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const messageId = 'manual-sync-message-123';
  const operationKey = 'retry-safe-key-123';
  const accepted = { accepted: true as const, commandId, runId, messageId };

  function ledgerRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
    return {
      id: 'ledger-row-id',
      operation_key: operationKey,
      domain: 'security',
      intent: 'manual_sync',
      kilo_user_id: 'user-123',
      organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      resource_key: `security:manual_sync:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:kilo/repo`,
      provider_ref: null,
      taxonomy: 'reconcile-first',
      status: 'admitted',
      outcome_code: null,
      canonical_result: null,
      admitted_at: '2026-06-17T10:00:00.000Z',
      settled_at: null,
      lease_expires_at: '2026-06-17T10:02:00.000Z',
      expires_at: '2026-07-17T10:00:00.000Z',
      ...overrides,
    };
  }

  it('admits a manual sync before submission and durably records the provider reference', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockResolvedValue(accepted);

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).resolves.toEqual({ success: true, ...accepted });

    expect(mockAdmitOperation.mock.calls[0]?.[1]).toMatchObject({
      userId: 'user-123',
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      domain: 'security',
      intent: 'manual_sync',
      operationKey,
      resourceKey: `security:manual_sync:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:kilo/repo`,
      taxonomy: 'reconcile-first',
    });
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: messageId,
      canonicalResult: { commandId, runId, messageId },
    });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledTimes(1);
  });

  it('replays a settled manual sync without re-submitting or re-tracking', async () => {
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({
        status: 'completed',
        canonical_result: { commandId, runId, messageId },
      }),
    });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).resolves.toEqual({
      success: true,
      accepted: true,
      commandId,
      runId,
      messageId,
      replayed: true,
    });

    expect(mockSubmitManualSecuritySync).not.toHaveBeenCalled();
    expect(mockRecordOperationAcceptance).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('conflicts on an in-flight manual sync instead of re-submitting', async () => {
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_in_flight',
      row: ledgerRow(),
    });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_in_progress' });
    expect(mockSubmitManualSecuritySync).not.toHaveBeenCalled();
  });

  it('conflicts when a reconcile retry is already in progress', async () => {
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_reconcile_in_progress',
      row: ledgerRow({ status: 'reconcile_pending' }),
    });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_in_progress' });
    expect(mockSubmitManualSecuritySync).not.toHaveBeenCalled();
  });

  it('re-submits a manual sync takeover under the same key', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'takeover', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockResolvedValue(accepted);

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).resolves.toEqual({ success: true, ...accepted });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledTimes(1);
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: messageId,
      canonicalResult: { commandId, runId, messageId },
    });
  });

  it('settles the row failed on a definitive pre-acceptance rejection', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockRejectedValue(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Security sync service request failed (status 400).',
      })
    );

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toThrow('status 400');

    const settleInput = mockSettleOperation.mock.calls[0]?.[1] as {
      rowId: string;
      status: string;
      outcomeCode: string;
      outboxEvent?: { eventName: string; properties: { outcome: string; intent: string } };
    };
    expect(settleInput).toMatchObject({
      rowId: 'ledger-row-id',
      status: 'failed',
      outcomeCode: 'pre_acceptance_rejected',
    });
    expect(settleInput?.outboxEvent?.eventName).toBe('security_command_settled');
    expect(settleInput?.outboxEvent?.properties).toMatchObject({
      intent: 'manual_sync',
      outcome: 'failed',
    });
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('marks the row reconcile_pending on ambiguous transport and surfaces a retryable conflict', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockRejectedValue(
      new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security sync service. Try again.',
      })
    );

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: "Couldn't confirm — check the security review before retrying.",
    });

    expect(mockMarkReconcilePending.mock.calls[0]?.[1]).toMatchObject({
      rowId: 'ledger-row-id',
    });
    const reconcileCall = mockMarkReconcilePending.mock.calls[0]?.[1] as {
      outboxEvent?: { eventName: string; properties: { outcome: string; intent: string } };
    };
    expect(reconcileCall?.outboxEvent?.eventName).toBe('security_command_settled');
    expect(reconcileCall?.outboxEvent?.properties).toMatchObject({
      intent: 'manual_sync',
      outcome: 'ambiguous',
    });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('rejects cross-intent key reuse before honoring any outcome', async () => {
    mockAdmitOperation.mockResolvedValue({
      admission: 'admitted',
      row: ledgerRow({ intent: 'dismiss_finding' }),
    });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
    expect(mockSubmitManualSecuritySync).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('never returns a success receipt when the acceptance cannot be recorded', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockResolvedValue(accepted);
    mockRecordOperationAcceptance.mockRejectedValue(new Error('database unavailable'));

    let captured: unknown;
    try {
      await createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      });
      throw new Error('expected rejection');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TRPCError);
    expect((captured as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((captured as TRPCError).message).toBe(
      'The action completed, but we could not record the result. Please try again.'
    );
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('writes the acceptance through ONE atomic helper so a failed record leaves no partial state that could blind-duplicate', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockResolvedValue(accepted);

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).resolves.toEqual({ success: true, ...accepted });

    // The acceptance record is a single atomic call carrying BOTH columns: a
    // separate provider_ref write (which could succeed while the canonical
    // result write fails, leaving a joinable half-record) must never happen.
    expect(mockRecordOperationAcceptance).toHaveBeenCalledTimes(1);
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: messageId,
      canonicalResult: { commandId, runId, messageId },
    });
  });

  it('surfaces a distinct persistence error when the reconcile-pending write fails', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockRejectedValue(
      new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security sync service. Try again.',
      })
    );
    mockMarkReconcilePending.mockRejectedValue(new Error('database unavailable'));

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'We could not record this action. Please try again later.',
    });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('never returns a success receipt when the acceptance returns no durable row (null)', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockResolvedValue(accepted);
    // `recordOperationAcceptance` returns null when the row is missing or
    // terminal: no `provider_ref`/`canonical_result` was durably recorded, so
    // a success receipt would be a false retry-safe claim.
    mockRecordOperationAcceptance.mockResolvedValue(null);

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The action completed, but we could not record the result. Please try again.',
    });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('surfaces the persistence error when the reconcile-pending mark returns no durable row (null)', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockRejectedValue(
      new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security sync service. Try again.',
      })
    );
    // The row vanished: no reconcile_pending state exists, so the ambiguous
    // CONFLICT (which promises same-key dedupe/reconcile) must not surface.
    mockMarkReconcilePending.mockResolvedValue(null);

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'We could not record this action. Please try again later.',
    });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('surfaces the persistence error when the reconcile-pending mark is a no-op (row not admitted)', async () => {
    mockAdmitOperation.mockResolvedValue({ admission: 'admitted', row: ledgerRow() });
    mockSubmitManualSecuritySync.mockRejectedValue(
      new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security sync service. Try again.',
      })
    );
    // The helper returns the stored row without transitioning it (the CAS did
    // not match because the row is not `admitted`): durable reconcile_pending
    // state does not exist, so the ambiguous CONFLICT must not be surfaced.
    mockMarkReconcilePending.mockResolvedValue({ status: 'admitted' });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'We could not record this action. Please try again later.',
    });
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('admits a finding dismissal with the dismissal resource key and records the provider reference', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: findingId,
      source: 'dependabot',
      severity: 'high',
    });
    mockAdmitOperation.mockResolvedValue({
      admission: 'admitted',
      row: ledgerRow({
        intent: 'dismiss_finding',
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}`,
      }),
    });
    mockSubmitManualFindingDismissal.mockResolvedValue({
      ...accepted,
      messageId: 'dismiss-message-123',
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: { findingId, reason: 'not_used', operationKey },
      })
    ).resolves.toEqual({
      success: true,
      accepted: true,
      commandId,
      runId,
      messageId: 'dismiss-message-123',
    });

    expect(mockAdmitOperation.mock.calls[0]?.[1]).toMatchObject({
      intent: 'dismiss_finding',
      operationKey,
      resourceKey: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}`,
    });
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: 'dismiss-message-123',
      canonicalResult: { commandId, runId, messageId: 'dismiss-message-123' },
    });
    expect(mockSubmitManualFindingDismissal).toHaveBeenCalledTimes(1);
  });

  it('replays a settled dismissal without re-triggering the GitHub call', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: findingId,
      source: 'dependabot',
      severity: 'high',
    });
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({
        intent: 'dismiss_finding',
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}`,
        status: 'completed',
        canonical_result: { commandId, runId, messageId: 'dismiss-message-123' },
      }),
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: { findingId, reason: 'not_used', operationKey },
      })
    ).resolves.toEqual({
      success: true,
      accepted: true,
      commandId,
      runId,
      messageId: 'dismiss-message-123',
      replayed: true,
    });
    expect(mockSubmitManualFindingDismissal).not.toHaveBeenCalled();
  });

  it('rejects a replay of a settled failed row as non-retryable', async () => {
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({ status: 'failed', outcome_code: 'pre_acceptance_rejected' }),
    });

    await expect(
      createHandlers().triggerSync.handler({
        ctx: context,
        input: { repoFullName: 'kilo/repo', operationKey },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This action did not complete. Please try again.',
    });
    expect(mockSubmitManualSecuritySync).not.toHaveBeenCalled();
  });
});

describe('remediation action tracking', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const attemptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('tracks accepted start, retry, and cancel actions', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: findingId });
    mockSubmitManualRemediationStart.mockResolvedValue({
      queued: true,
      remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId,
      attemptNumber: 1,
    });
    mockSubmitRemediationCancellation.mockResolvedValue({
      success: true,
      status: 'cancellation_requested',
    });
    const handlers = createHandlers();

    await handlers.startRemediation.handler({ ctx: context, input: { findingId } });
    await handlers.retryRemediation.handler({ ctx: context, input: { findingId } });
    await handlers.cancelRemediation.handler({ ctx: context, input: { attemptId } });

    expect(mockTrackSecurityAgentRemediationAction).toHaveBeenNthCalledWith(1, {
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: undefined,
      action: 'start',
    });
    expect(mockTrackSecurityAgentRemediationAction).toHaveBeenNthCalledWith(2, {
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: undefined,
      action: 'retry',
    });
    expect(mockTrackSecurityAgentRemediationAction).toHaveBeenNthCalledWith(3, {
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: undefined,
      action: 'cancel',
    });
  });

  it('returns typed policy rejections without tracking accepted remediation', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: findingId });
    mockSubmitManualRemediationStart.mockResolvedValue({
      queued: false,
      reason: 'analysis_required',
    });
    const handlers = createHandlers();

    await expect(
      handlers.startRemediation.handler({ ctx: context, input: { findingId } })
    ).resolves.toEqual({ success: false, queued: false, reason: 'analysis_required' });

    expect(mockTrackSecurityAgentRemediationAction).not.toHaveBeenCalled();
  });

  it('does not track remediation actions rejected by admission handlers', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: findingId });
    mockSubmitManualRemediationStart.mockRejectedValue(new Error('not admitted'));
    mockSubmitRemediationCancellation.mockRejectedValue(new Error('not cancellable'));
    const handlers = createHandlers();

    await expect(
      handlers.startRemediation.handler({ ctx: context, input: { findingId } })
    ).rejects.toThrow('not admitted');
    await expect(
      handlers.retryRemediation.handler({ ctx: context, input: { findingId } })
    ).rejects.toThrow('not admitted');
    await expect(
      handlers.cancelRemediation.handler({ ctx: context, input: { attemptId } })
    ).rejects.toThrow('not cancellable');

    expect(mockTrackSecurityAgentRemediationAction).not.toHaveBeenCalled();
  });
});
