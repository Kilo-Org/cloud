import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { createSecurityAgentHandlers as createSecurityAgentHandlersType } from './shared-handlers';
import type * as manualSyncClientModule from '../services/manual-sync-client';
import type * as manualDismissClientModule from '../services/manual-dismiss-client';
import type * as manualAnalysisClientModule from '../services/manual-analysis-client';

const mockSubmitManualSecuritySync = jest.fn() as jest.MockedFunction<
  typeof manualSyncClientModule.submitManualSecuritySync
>;
const mockSubmitManualFindingDismissal = jest.fn() as jest.MockedFunction<
  typeof manualDismissClientModule.submitManualFindingDismissal
>;
const mockSubmitManualAnalysisStart = jest.fn() as jest.MockedFunction<
  typeof manualAnalysisClientModule.submitManualAnalysisStart
>;
const mockGetSecurityFindingById = jest.fn();
const mockCanStartAnalysis = jest.fn();
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
    SyncTriggered: 'sync_triggered',
    FindingDismissed: 'finding_dismissed',
  },
}));

jest.mock('../db/security-config', () => ({
  getSecurityAgentConfigWithStatus: jest.fn(),
  upsertSecurityAgentConfig: jest.fn(),
  setSecurityAgentEnabled: jest.fn(),
}));

jest.mock('../db/security-findings', () => ({
  listSecurityFindings: jest.fn(),
  getSecurityFindingById: mockGetSecurityFindingById,
  getSecurityFindingsSummary: jest.fn(),
  updateSecurityFindingStatus: jest.fn(),
  getLastSyncTime: jest.fn(),
  getOrphanedRepositoriesWithFindingCounts: jest.fn(),
  deleteFindingsByRepository: jest.fn(),
}));

jest.mock('../db/dashboard-stats', () => ({ getDashboardStats: jest.fn() }));
jest.mock('../db/security-analysis', () => ({
  canStartAnalysis: mockCanStartAnalysis,
  enqueueBacklogFindings: jest.fn(),
}));
jest.mock('../services/analysis-service', () => ({ startSecurityAnalysis: jest.fn() }));
jest.mock('../core/error-classification', () => ({ trpcCodeForAnalysisError: jest.fn() }));
jest.mock('../services/auto-dismiss-service', () => ({
  autoDismissEligibleFindings: jest.fn(),
  countEligibleForAutoDismiss: jest.fn(),
}));
jest.mock('../github/dependabot-api', () => ({ dismissDependabotAlert: jest.fn() }));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  updateRepositoriesForIntegration: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubRepositories: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  rethrowAsPaymentRequired: jest.fn(),
}));

let createSecurityAgentHandlers: typeof createSecurityAgentHandlersType;

beforeAll(async () => {
  ({ createSecurityAgentHandlers } = await import('./shared-handlers'));
});

function createHandlers() {
  return createSecurityAgentHandlers({
    resolveOwner: () => ({
      type: 'org',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'user-123',
    }),
    resolveSecurityOwner: () => ({
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    resolveResourceId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    verifyFindingOwnership: () => true,
    getIntegration: async () =>
      ({
        id: 'integration-123',
        integration_status: 'active',
        platform_installation_id: 'installation-123',
        repositories: [{ full_name: 'kilo/repo' }],
      }) as never,
    trackingExtras: () => ({}),
  });
}

describe('setEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubmitManualSecuritySync.mockResolvedValue({
      accepted: true,
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      messageId: 'enable-sync-message-123',
    });
  });

  it('queues initial sync through Worker processing instead of running inline web sync', async () => {
    const handlers = createHandlers();

    const result = await handlers.setEnabled.handler({
      ctx: {
        user: {
          id: 'user-123',
          google_user_email: 'owner@example.com',
          google_user_name: 'Owner Example',
        },
      } as never,
      input: {
        isEnabled: true,
        repositorySelectionMode: 'all',
        selectedRepositoryIds: [],
      },
    });

    expect(result).toEqual({
      success: true,
      initialSync: {
        accepted: true,
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        messageId: 'enable-sync-message-123',
      },
    });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledWith({
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
    });
  });
});

describe('startAnalysis', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSecurityFindingById.mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      repo_full_name: 'kilo/repo',
      status: 'open',
    } as never);
    mockCanStartAnalysis.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 3,
    } as never);
    mockSubmitManualAnalysisStart.mockResolvedValue({ queued: true });
  });

  it('returns queued Worker orchestration instead of claiming analysis started inline', async () => {
    const handlers = createHandlers();
    const result = await handlers.startAnalysis.handler({
      ctx: {
        user: {
          id: 'user-123',
          google_user_email: 'owner@example.com',
          google_user_name: 'Owner Example',
        },
      } as never,
      input: {
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        analysisModel: 'analysis/model',
      },
    });

    expect(result).toEqual({ success: true, queued: true });
    expect(mockSubmitManualAnalysisStart).toHaveBeenCalledWith({
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actorUserId: 'user-123',
      requestedModels: {
        model: undefined,
        triageModel: undefined,
        analysisModel: 'analysis/model',
      },
      retrySandboxOnly: undefined,
    });
  });
});

describe('triggerSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubmitManualSecuritySync.mockResolvedValue({
      accepted: true,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      messageId: 'message-123',
    });
  });

  it('returns accepted async Worker correlation without running inline repository sync', async () => {
    const handlers = createHandlers();

    const result = await handlers.triggerSync.handler({
      ctx: {
        user: {
          id: 'user-123',
          google_user_email: 'owner@example.com',
          google_user_name: 'Owner Example',
        },
      } as never,
      input: { repoFullName: 'kilo/repo' },
    });

    expect(result).toEqual({
      success: true,
      accepted: true,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      messageId: 'message-123',
    });
    expect(mockSubmitManualSecuritySync).toHaveBeenCalledWith({
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
      repoFullName: 'kilo/repo',
    });
  });
});

describe('dismissFinding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSecurityFindingById.mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      source: 'dependabot',
      source_id: '42',
      repo_full_name: 'kilo/repo',
      status: 'open',
      severity: 'high',
    } as never);
    mockSubmitManualFindingDismissal.mockResolvedValue({
      accepted: true,
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dismiss-message-123',
    });
  });

  it('returns accepted async Worker correlation without mutating dismissal inline', async () => {
    const handlers = createHandlers();

    const result = await handlers.dismissFinding.handler({
      ctx: {
        user: {
          id: 'user-123',
          google_user_email: 'owner@example.com',
          google_user_name: 'Owner Example',
        },
      } as never,
      input: {
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        reason: 'not_used',
        comment: 'No production usage',
      },
    });

    expect(result).toEqual({
      success: true,
      accepted: true,
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dismiss-message-123',
    });
    expect(mockSubmitManualFindingDismissal).toHaveBeenCalledWith({
      owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actor: { id: 'user-123', email: 'owner@example.com', name: 'Owner Example' },
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId: 'installation-123',
      reason: 'not_used',
      comment: 'No production usage',
    });
  });
});
