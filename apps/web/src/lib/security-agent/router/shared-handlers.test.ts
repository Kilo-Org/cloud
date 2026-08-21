import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { createSecurityAgentHandlers as createSecurityAgentHandlersType } from './shared-handlers';
import type * as manualSyncClientModule from '../services/manual-sync-client';
import type * as manualDismissClientModule from '../services/manual-dismiss-client';
import type * as manualAnalysisClientModule from '../services/manual-analysis-client';
import type * as manualRemediationClientModule from '../services/manual-remediation-client';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  operation_ledgers,
  organizations,
  security_audit_log,
  type OperationLedgerRow,
} from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import type { SecurityFindingWithRemediation } from '../db/security-remediation';

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
const mockListSecurityFindings = jest.fn<() => Promise<unknown>>();
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
const mockSaveSecurityAgentConfigWithRevision = jest.fn<
  (params: unknown) => Promise<{
    newRevision: number;
    existingFindingsQueuedCount?: number;
    existingRemediationCommandId?: string;
  }>
>();
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
const mockGetSecurityAgentCommandStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetSecurityAgentCommandStatuses = jest.fn<(...args: unknown[]) => Promise<unknown>>();

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
  isTerminalOperationStatus: (status: string) =>
    ['completed', 'failed', 'no_op', 'interrupted', 'superseded'].includes(status),
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
  saveSecurityAgentConfigWithRevision: mockSaveSecurityAgentConfigWithRevision,
  setSecurityAgentEnabled: mockSetSecurityAgentEnabled,
}));
jest.mock('../db/security-findings', () => ({
  listSecurityFindings: mockListSecurityFindings,
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
  getSecurityAgentCommandStatus: mockGetSecurityAgentCommandStatus,
  getSecurityAgentCommandStatuses: mockGetSecurityAgentCommandStatuses,
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
  mockSaveSecurityAgentConfigWithRevision.mockResolvedValue({ newRevision: 1 });
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

  it('pins the high-confidence automation defaults for legacy configs', async () => {
    mockGetSecurityAgentConfigWithStatus.mockResolvedValue({
      isEnabled: true,
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
        analysis_mode: 'auto',
        auto_dismiss_enabled: false,
        auto_analysis_enabled: false,
        auto_analysis_include_existing: false,
        auto_remediation_enabled: false,
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
      autoDismissConfidenceThreshold: 'high',
      autoAnalysisMinSeverity: 'high',
      autoRemediationMinSeverity: 'high',
      autoRemediationRequireApproval: true,
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

  it('refuses enabling with an empty selected repo set', async () => {
    await expect(
      createHandlers().setEnabled.handler({
        ctx: context,
        input: { isEnabled: true, repositorySelectionMode: 'selected', selectedRepositoryIds: [] },
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Select at least one repository before enabling Security Agent.',
    });
    expect(mockUpsertSecurityAgentConfig).not.toHaveBeenCalled();
    expect(mockSetSecurityAgentEnabled).not.toHaveBeenCalled();
  });

  it('refuses enabling with all mode and zero integration repos', async () => {
    await expect(
      createPersonalHandlers().setEnabled.handler({
        ctx: context,
        input: { isEnabled: true, repositorySelectionMode: 'all', selectedRepositoryIds: [] },
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Select at least one repository before enabling Security Agent.',
    });
    expect(mockUpsertSecurityAgentConfig).not.toHaveBeenCalled();
    expect(mockSetSecurityAgentEnabled).not.toHaveBeenCalled();
  });
});

describe('saveConfig', () => {
  it('delegates to the CAS save and returns the queued count', async () => {
    mockSaveSecurityAgentConfigWithRevision.mockResolvedValue({
      newRevision: 2,
      existingFindingsQueuedCount: 4,
    });

    await expect(
      createHandlers().saveConfig.handler({
        ctx: context,
        input: {
          expectedRevision: 1,
          autoAnalysisEnabled: true,
          autoAnalysisIncludeExisting: true,
        },
      })
    ).resolves.toMatchObject({ success: true, existingFindingsQueuedCount: 4 });

    expect(mockSaveSecurityAgentConfigWithRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        enqueueAnalysis: {
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          minSeverity: 'high',
        },
      })
    );
  });

  it('propagates a stale-revision CONFLICT without a success receipt', async () => {
    mockSaveSecurityAgentConfigWithRevision.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'stale revision' })
    );

    await expect(
      createHandlers().saveConfig.handler({
        ctx: context,
        input: { expectedRevision: 1 },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps autoRemediationRequireApproval to the snake_case config field', async () => {
    mockSaveSecurityAgentConfigWithRevision.mockResolvedValue({ newRevision: 2 });

    await createHandlers().saveConfig.handler({
      ctx: context,
      input: { expectedRevision: 1, autoRemediationRequireApproval: false },
    });

    expect(mockSaveSecurityAgentConfigWithRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ auto_remediation_require_approval: false }),
      })
    );
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

describe('getAnalysis remediation timeline', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const finding = {
    id: findingId,
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
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

  async function insertAuditRow(
    action: SecurityAuditLogAction,
    occurredAt: string | null,
    createdAt: string
  ) {
    await db.insert(security_audit_log).values({
      owned_by_organization_id: orgId,
      owned_by_user_id: null,
      action,
      resource_type: 'security_finding',
      resource_id: findingId,
      finding_id: findingId,
      occurred_at: occurredAt,
      created_at: createdAt,
    });
  }

  beforeEach(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: 'Timeline Test Org' })
      .onConflictDoNothing();
    await db.delete(security_audit_log).where(eq(security_audit_log.finding_id, findingId));
    mockGetSecurityFindingById.mockResolvedValue(finding);
    mockDecorateFindingWithRemediation.mockResolvedValue(decoratedFinding);
  });

  afterAll(async () => {
    await db.delete(security_audit_log).where(eq(security_audit_log.finding_id, findingId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it('orders remediation events ascending by occurred_at with created_at fallback and normalizes to UTC ISO', async () => {
    await insertAuditRow(
      SecurityAuditLogAction.RemediationQueued,
      '2026-04-29 01:16:12.945+00',
      '2026-04-29 01:16:12.945+00'
    );
    await insertAuditRow(
      SecurityAuditLogAction.RemediationPrOpened,
      null,
      '2026-04-29 02:00:00.000+00'
    );
    await insertAuditRow(
      SecurityAuditLogAction.RemediationFailed,
      '2026-04-29 01:30:00.000+00',
      '2026-04-29 01:30:00.000+00'
    );

    const result = await createHandlers().getAnalysis.handler({
      ctx: context,
      input: { findingId },
    });

    expect(result.remediationTimeline).toEqual([
      { action: 'security.remediation.queued', occurredAt: '2026-04-29T01:16:12.945Z' },
      { action: 'security.remediation.failed', occurredAt: '2026-04-29T01:30:00.000Z' },
      { action: 'security.remediation.pr_opened', occurredAt: '2026-04-29T02:00:00.000Z' },
    ]);
  });

  it('returns only remediation actions, not finding lifecycle actions', async () => {
    await insertAuditRow(
      SecurityAuditLogAction.FindingCreated,
      '2026-04-29 01:00:00.000+00',
      '2026-04-29 01:00:00.000+00'
    );
    await insertAuditRow(
      SecurityAuditLogAction.RemediationQueued,
      '2026-04-29 01:10:00.000+00',
      '2026-04-29 01:10:00.000+00'
    );

    const result = await createHandlers().getAnalysis.handler({
      ctx: context,
      input: { findingId },
    });

    expect(result.remediationTimeline.map(event => event.action)).toEqual([
      'security.remediation.queued',
    ]);
  });

  it('returns an empty timeline when no remediation audit rows exist, keeping the original shape valid', async () => {
    const result = await createHandlers().getAnalysis.handler({
      ctx: context,
      input: { findingId },
    });

    expect(result.remediationTimeline).toEqual([]);
    expect(result).toMatchObject({
      findingState: { status: 'open' },
      status: 'completed',
      remediationAttempts: [],
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
      expect.objectContaining({ actor: { id: 'user-123', email: 'owner@example.com' } })
    );
  });

  it('returns manual analysis command correlation', async () => {
    mockGetSecurityFindingById.mockResolvedValue({ id: 'finding-id' });
    mockCanStartAnalysis.mockResolvedValue({ allowed: true, currentCount: 0, limit: 3 });
    mockSubmitManualAnalysisStart.mockResolvedValue({ queued: true, commandId });
    mockAdmitOperation.mockResolvedValue({
      admission: 'admitted',
      row: {
        id: 'ledger-row-id',
        intent: 'start_analysis',
        resource_key:
          'security:start_analysis:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });

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
    mockAdmitOperation.mockResolvedValue({
      admission: 'admitted',
      row: {
        id: 'ledger-row-id',
        intent: 'start_analysis',
        resource_key:
          'security:start_analysis:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });

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
      providerRef: commandId,
      canonicalResult: { commandId, runId, messageId },
    });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledTimes(1);
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey })
    );
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
      providerRef: commandId,
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
      providerRef: commandId,
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
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:`,
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
      resourceKey: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:`,
    });
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: commandId,
      canonicalResult: { commandId, runId, messageId: 'dismiss-message-123' },
    });
    expect(mockSubmitManualFindingDismissal).toHaveBeenCalledTimes(1);
    expect(mockSubmitManualFindingDismissal).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey })
    );
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
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:`,
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

  it('rejects a same-key dismissal when the reason differs', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: findingId,
      source: 'dependabot',
      severity: 'high',
    });
    // The row was admitted for the same key with a DIFFERENT reason, so the
    // dismissal intent identity does not match the stored resource key.
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({
        intent: 'dismiss_finding',
        status: 'completed',
        canonical_result: { commandId, runId, messageId: 'dismiss-message-123' },
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:`,
      }),
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: { findingId, reason: 'fix_started', operationKey },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
    expect(mockSubmitManualFindingDismissal).not.toHaveBeenCalled();
  });

  it('rejects a same-key dismissal when the comment differs', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: findingId,
      source: 'dependabot',
      severity: 'high',
    });
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({
        intent: 'dismiss_finding',
        status: 'completed',
        canonical_result: { commandId, runId, messageId: 'dismiss-message-123' },
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:No production usage`,
      }),
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: {
          findingId,
          reason: 'not_used',
          comment: 'Actually used in production',
          operationKey,
        },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
    expect(mockSubmitManualFindingDismissal).not.toHaveBeenCalled();
  });

  it('treats same-key dismissal comments as equal after whitespace normalization', async () => {
    mockGetSecurityFindingById.mockResolvedValue({
      id: findingId,
      source: 'dependabot',
      severity: 'high',
    });
    mockAdmitOperation.mockResolvedValue({
      admission: 'duplicate_settled',
      row: ledgerRow({
        intent: 'dismiss_finding',
        status: 'completed',
        canonical_result: { commandId, runId, messageId: 'dismiss-message-123' },
        resource_key: `security:dismiss_finding:org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${findingId}:not_used:No production usage`,
      }),
    });

    await expect(
      createHandlers().dismissFinding.handler({
        ctx: context,
        input: {
          findingId,
          reason: 'not_used',
          comment: '  No  production   usage  ',
          operationKey,
        },
      })
    ).resolves.toMatchObject({
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

describe('terminal command ledger settle', () => {
  const settleCommandId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';

  function terminalCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: settleCommandId,
      commandType: 'sync',
      origin: 'dashboard_refresh',
      findingId: null,
      repoFullName: 'kilo/repo',
      status: 'succeeded',
      resultCode: 'SYNC_COMPLETED',
      resultMetadata: null,
      lastErrorRedacted: null,
      acceptedAt: '2026-06-17T10:00:00.000Z',
      startedAt: '2026-06-17T10:00:01.000Z',
      completedAt: '2026-06-17T10:00:09.000Z',
      updatedAt: '2026-06-17T10:00:09.000Z',
      ...overrides,
    };
  }

  async function insertLedgerRow(overrides: Partial<OperationLedgerRow> = {}) {
    const [row] = await db
      .insert(operation_ledgers)
      .values({
        operation_key: `settle-key-${randomUUID()}`,
        domain: 'security',
        intent: 'manual_sync',
        kilo_user_id: 'user-123',
        taxonomy: 'reconcile-first',
        status: 'admitted',
        provider_ref: settleCommandId,
        admitted_at: '2026-06-17T10:00:00.000Z',
        lease_expires_at: '2026-06-17T10:02:00.000Z',
        expires_at: '2026-07-17T10:00:00.000Z',
        ...overrides,
      })
      .returning();
    return row!;
  }

  beforeEach(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
  });

  it('settles the admitting user row and emits the terminal event once the command succeeds', async () => {
    const row = await insertLedgerRow();
    mockGetSecurityAgentCommandStatus.mockResolvedValue(terminalCommand());

    await expect(
      createHandlers().getCommandStatus.handler({
        ctx: context,
        input: { commandId: settleCommandId },
      })
    ).resolves.toMatchObject({ id: settleCommandId, status: 'succeeded' });

    expect(mockSettleOperation).toHaveBeenCalledTimes(1);
    expect(mockSettleOperation.mock.calls[0]?.[1]).toEqual({
      rowId: row.id,
      status: 'completed',
      outcomeCode: 'SYNC_COMPLETED',
      outboxEvent: {
        eventName: 'security_command_settled',
        distinctId: 'owner@example.com',
        properties: {
          source: 'web',
          surface: 'security',
          phase: 'terminal',
          intent: 'manual_sync',
          outcome: 'completed',
          duration_ms: expect.any(Number),
        },
      },
    });
  });

  it('maps a no-op command to a no_op settle', async () => {
    await insertLedgerRow();
    mockGetSecurityAgentCommandStatus.mockResolvedValue(
      terminalCommand({ status: 'no_op', resultCode: 'CONFIG_DISABLED' })
    );

    await createHandlers().getCommandStatus.handler({
      ctx: context,
      input: { commandId: settleCommandId },
    });

    expect(mockSettleOperation.mock.calls[0]?.[1]).toMatchObject({
      status: 'no_op',
      outcomeCode: 'CONFIG_DISABLED',
      outboxEvent: expect.objectContaining({
        properties: expect.objectContaining({ outcome: 'no_op' }),
      }),
    });
  });

  it('does not settle again once the row is terminal, so the event is emitted once', async () => {
    await insertLedgerRow({ status: 'completed', settled_at: '2026-06-17T10:00:09.000Z' });
    mockGetSecurityAgentCommandStatus.mockResolvedValue(terminalCommand());

    await createHandlers().getCommandStatus.handler({
      ctx: context,
      input: { commandId: settleCommandId },
    });

    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('never settles another user row from a poll', async () => {
    await insertLedgerRow({ kilo_user_id: 'other-user' });
    mockGetSecurityAgentCommandStatus.mockResolvedValue(terminalCommand());

    await createHandlers().getCommandStatus.handler({
      ctx: context,
      input: { commandId: settleCommandId },
    });

    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('does not read the ledger while the command is still running', async () => {
    await insertLedgerRow();
    mockGetSecurityAgentCommandStatus.mockResolvedValue(
      terminalCommand({ status: 'running', resultCode: null })
    );

    await createHandlers().getCommandStatus.handler({
      ctx: context,
      input: { commandId: settleCommandId },
    });

    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('returns the command state even when the settle throws', async () => {
    await insertLedgerRow();
    mockGetSecurityAgentCommandStatus.mockResolvedValue(terminalCommand());
    mockSettleOperation.mockRejectedValueOnce(new Error('settle failed'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      createHandlers().getCommandStatus.handler({
        ctx: context,
        input: { commandId: settleCommandId },
      })
    ).resolves.toMatchObject({ id: settleCommandId });

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('getCommandStatuses', () => {
  const batchCommandId = 'aaaabbbb-cccc-4ddd-8eee-ffff00002222';

  function terminalCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: batchCommandId,
      commandType: 'sync',
      origin: 'dashboard_refresh',
      findingId: null,
      repoFullName: 'kilo/repo',
      status: 'succeeded',
      resultCode: 'SYNC_COMPLETED',
      resultMetadata: null,
      lastErrorRedacted: null,
      acceptedAt: '2026-06-17T10:00:00.000Z',
      startedAt: '2026-06-17T10:00:01.000Z',
      completedAt: '2026-06-17T10:00:09.000Z',
      updatedAt: '2026-06-17T10:00:09.000Z',
      ...overrides,
    };
  }

  async function insertLedgerRow(overrides: Partial<OperationLedgerRow> = {}) {
    const [row] = await db
      .insert(operation_ledgers)
      .values({
        operation_key: `settle-key-${randomUUID()}`,
        domain: 'security',
        intent: 'manual_sync',
        kilo_user_id: 'user-123',
        taxonomy: 'reconcile-first',
        status: 'admitted',
        provider_ref: batchCommandId,
        admitted_at: '2026-06-17T10:00:00.000Z',
        lease_expires_at: '2026-06-17T10:02:00.000Z',
        expires_at: '2026-07-17T10:00:00.000Z',
        ...overrides,
      })
      .returning();
    return row!;
  }

  beforeEach(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
  });

  it('rejects an empty array, a non-uuid id, and more than 100 ids at the schema boundary', () => {
    const schema = createHandlers().getCommandStatuses.inputSchema;
    const ids = Array.from({ length: 101 }, () => '00000000-0000-4000-8000-000000000000');

    expect(schema.safeParse({ commandIds: [] }).success).toBe(false);
    expect(schema.safeParse({ commandIds: ['not-a-uuid'] }).success).toBe(false);
    expect(schema.safeParse({ commandIds: ids }).success).toBe(false);
    expect(schema.safeParse({ commandIds: ids.slice(0, 100) }).success).toBe(true);
  });

  it('returns only the commands the db layer resolved and never throws for unknown ids', async () => {
    mockGetSecurityAgentCommandStatuses.mockResolvedValue([terminalCommand()]);

    await expect(
      createHandlers().getCommandStatuses.handler({
        ctx: context,
        input: { commandIds: [batchCommandId, '00000000-0000-4000-8000-000000000000'] },
      })
    ).resolves.toEqual([terminalCommand()]);

    expect(mockGetSecurityAgentCommandStatuses).toHaveBeenCalledWith(
      { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      [batchCommandId, '00000000-0000-4000-8000-000000000000']
    );
  });

  it('settles a terminal command exactly once across repeated batch calls', async () => {
    const row = await insertLedgerRow();
    mockGetSecurityAgentCommandStatuses.mockResolvedValue([terminalCommand()]);
    mockSettleOperation.mockImplementationOnce(async () => {
      await db
        .update(operation_ledgers)
        .set({ status: 'completed' })
        .where(eq(operation_ledgers.id, row.id));
      return { settled: true };
    });

    const handlers = createHandlers();
    await handlers.getCommandStatuses.handler({
      ctx: context,
      input: { commandIds: [batchCommandId] },
    });
    await handlers.getCommandStatuses.handler({
      ctx: context,
      input: { commandIds: [batchCommandId] },
    });

    expect(mockSettleOperation).toHaveBeenCalledTimes(1);
  });
});

describe('findings list DTO narrowing', () => {
  function makeFullDecoratedFinding(): SecurityFindingWithRemediation {
    return {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      owned_by_user_id: null,
      platform_integration_id: null,
      repo_full_name: 'kilo/repo',
      source: 'dependabot',
      source_id: '42',
      severity: 'high',
      ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
      cve_id: 'CVE-2026-0001',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      vulnerable_version_range: '<4.17.21',
      patched_version: '4.17.21',
      manifest_path: 'package.json',
      title: 'Prototype Pollution in lodash',
      description: 'A prototype pollution vulnerability',
      status: 'open',
      ignored_reason: null,
      ignored_by: null,
      fixed_at: null,
      sla_due_at: '2026-08-21T00:00:00.000Z',
      dependabot_html_url: 'https://github.com/kilo/repo/security/dependabot/42',
      cwe_ids: ['CWE-1321'],
      cvss_score: '7.5',
      dependency_scope: 'runtime',
      session_id: null,
      cli_session_id: null,
      analysis_status: 'completed',
      analysis_started_at: '2026-08-20T00:00:00.000Z',
      analysis_completed_at: '2026-08-20T00:05:00.000Z',
      analysis_error: null,
      analysis: {
        analyzedAt: '2026-08-20T00:05:00.000Z',
        rawMarkdown: 'heavy analysis markdown',
        modelUsed: 'analysis-model',
        triage: {
          needsSandboxAnalysis: true,
          needsSandboxReasoning: 'needs sandbox',
          suggestedAction: 'analyze_codebase',
          confidence: 'high',
          triageAt: '2026-08-20T00:04:00.000Z',
        },
        sandboxAnalysis: {
          isExploitable: 'unknown',
          extractionStatus: 'failed',
          exploitabilityReasoning: 'sandbox reasoning',
          usageLocations: ['index.js'],
          suggestedFix: 'upgrade lodash',
          suggestedAction: 'monitor',
          summary: 'sandbox summary',
          rawMarkdown: 'sandbox markdown',
          analysisAt: '2026-08-20T00:05:00.000Z',
          modelUsed: 'sandbox-model',
        },
      },
      raw_data: { number: 42, state: 'open' },
      first_detected_at: '2026-08-01T00:00:00.000Z',
      last_synced_at: '2026-08-20T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-20T00:05:00.000Z',
      remediationSummary: {
        id: 'remediation-id',
        status: 'pr_opened',
        latestAttemptId: 'attempt-id',
        prUrl: 'https://github.com/kilo/repo/pull/99',
        prNumber: 99,
        prDraft: false,
        prHeadBranch: 'fix/lodash',
        prBaseBranch: 'main',
        failureCode: null,
        blockedReason: null,
        outcomeSummary: 'PR opened',
        completedAt: null,
        updatedAt: '2026-08-20T00:10:00.000Z',
        latestAttempt: {
          id: 'attempt-id',
          status: 'pr_opened',
          origin: 'manual',
          attemptNumber: 1,
          requestedByUserId: 'user-123',
          remediationModelSlug: 'remediation-model',
          branchName: 'fix/lodash',
          prUrl: 'https://github.com/kilo/repo/pull/99',
          prNumber: 99,
          prDraft: false,
          prHeadBranch: 'fix/lodash',
          prBaseBranch: 'main',
          failureCode: null,
          blockedReason: null,
          lastErrorRedacted: null,
          validationEvidence: null,
          riskNotes: null,
          draftReason: null,
          cancellationRequestedAt: null,
          queuedAt: '2026-08-20T00:06:00.000Z',
          launchedAt: '2026-08-20T00:07:00.000Z',
          completedAt: '2026-08-20T00:09:00.000Z',
          createdAt: '2026-08-20T00:06:00.000Z',
          updatedAt: '2026-08-20T00:09:00.000Z',
        },
      },
      remediationCapability: {
        canStart: false,
        startReason: 'finding_not_open',
        canRetry: false,
        retryReason: 'finding_not_open',
        canCancel: false,
        cancelAttemptId: null,
      },
    } as SecurityFindingWithRemediation;
  }

  it('returns list rows with raw_data nulled', async () => {
    const decoratedFinding = makeFullDecoratedFinding();
    mockListSecurityFindings.mockResolvedValue({ findings: [decoratedFinding], totalCount: 1 });
    mockDecorateFindingsWithRemediation.mockResolvedValue([decoratedFinding]);
    mockCanStartAnalysis.mockResolvedValue({ allowed: true, currentCount: 0, limit: 3 });

    const result = await createHandlers().listFindings.handler({
      ctx: context,
      input: { sortBy: 'severity_desc', limit: 10, offset: 0 },
    });

    const row = result.findings[0]!;
    expect(row.raw_data).toBeNull();

    // Exact key set: the full decorated row; nothing else added or dropped.
    const expectedKeys = Object.keys(decoratedFinding).sort();
    expect(Object.keys(row).sort()).toEqual(expectedKeys);

    // analysis stays fully intact, including the heavy payloads the web
    // detail dialog reads.
    expect(row.analysis).toEqual(decoratedFinding.analysis);

    // remediationSummary stays fully intact, including latestAttempt.
    expect(row.remediationSummary).toEqual(decoratedFinding.remediationSummary);
    expect(row.remediationSummary?.latestAttempt).toBeDefined();
  });

  it('keeps the heavy fields on the detail getFinding response', async () => {
    const decoratedFinding = makeFullDecoratedFinding();
    mockGetSecurityFindingById.mockResolvedValue(decoratedFinding);
    mockDecorateFindingWithRemediation.mockResolvedValue(decoratedFinding);

    const result = await createHandlers().getFinding.handler({
      ctx: context,
      input: { id: decoratedFinding.id },
    });

    expect(result).toEqual(decoratedFinding);
    expect(result.raw_data).toBeDefined();
    expect(result.analysis).toEqual(decoratedFinding.analysis);
    expect(result.remediationSummary?.latestAttempt).toBeDefined();
  });
});
