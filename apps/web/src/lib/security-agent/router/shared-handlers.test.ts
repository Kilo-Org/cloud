import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { createSecurityAgentHandlers as createSecurityAgentHandlersType } from './shared-handlers';
import type * as manualSyncClientModule from '../services/manual-sync-client';
import type * as manualDismissClientModule from '../services/manual-dismiss-client';
import type * as manualAnalysisClientModule from '../services/manual-analysis-client';

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
const mockGetSecurityFindingById = jest.fn<() => Promise<unknown>>();
const mockCanStartAnalysis = jest.fn<() => Promise<unknown>>();
const mockEnqueueBacklogFindings = jest.fn<() => Promise<number>>();
const mockGetSecurityAgentConfigWithStatus = jest.fn<() => Promise<unknown>>();
const mockTrackSecurityAgentSync = jest.fn();
const mockLogSecurityAudit = jest.fn();

jest.mock('../services/manual-sync-client', () => ({
  submitManualSecuritySync: mockSubmitManualSecuritySync,
}));
jest.mock('../services/manual-dismiss-client', () => ({
  submitManualFindingDismissal: mockSubmitManualFindingDismissal,
}));
jest.mock('../services/manual-analysis-client', () => ({
  submitManualAnalysisStart: mockSubmitManualAnalysisStart,
}));
jest.mock('../github/permissions', () => ({
  hasSecurityReviewPermissions: () => true,
  getReauthorizeUrl: jest.fn(),
}));
jest.mock('../posthog-tracking', () => ({
  trackSecurityAgentEnabled: jest.fn(),
  trackSecurityAgentConfigSaved: jest.fn(),
  trackSecurityAgentSync: mockTrackSecurityAgentSync,
  trackSecurityAgentFindingDismissed: jest.fn(),
}));
jest.mock('../services/audit-log-service', () => ({
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
  upsertSecurityAgentConfig: jest.fn(),
  setSecurityAgentEnabled: jest.fn(),
}));
jest.mock('../db/security-findings', () => ({
  listSecurityFindings: jest.fn(),
  getSecurityFindingById: mockGetSecurityFindingById,
  getSecurityFindingsSummary: jest.fn(),
  getLastSyncTime: jest.fn(),
  getOrphanedRepositoriesWithFindingCounts: jest.fn(),
  deleteFindingsByRepository: jest.fn(),
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
  autoDismissEligibleFindings: jest.fn(),
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
  mockEnqueueBacklogFindings.mockResolvedValue(0);
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
        repositories: [{ id: 1, full_name: 'kilo/repo' }],
      }) as never,
    trackingExtras: () => ({}),
  });
}

const context = {
  user: {
    id: 'user-123',
    google_user_email: 'owner@example.com',
    google_user_name: 'Owner Example',
  },
} as never;

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
  });
});
