import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as dependabotApiModule from '../github/dependabot-api';
import type * as parserModule from '../parsers/dependabot-parser';
import type * as findingsDbModule from '../db/security-findings';
import type * as configDbModule from '../db/security-config';
import type * as analysisDbModule from '../db/security-analysis';
import type {
  syncAllReposForOwner as syncAllReposForOwnerType,
  syncDependabotAlertsForRepo as syncDependabotAlertsForRepoType,
} from './sync-service';

const mockFetchAllDependabotAlerts = jest.fn() as jest.MockedFunction<
  typeof dependabotApiModule.fetchAllDependabotAlerts
>;
const mockParseDependabotAlerts = jest.fn() as jest.MockedFunction<
  typeof parserModule.parseDependabotAlerts
>;
const mockUpsertSecurityFinding = jest.fn() as jest.MockedFunction<
  typeof findingsDbModule.upsertSecurityFinding
>;
const mockGetSecurityAgentConfigWithStatus = jest.fn() as jest.MockedFunction<
  typeof configDbModule.getSecurityAgentConfigWithStatus
>;
const mockGetSecurityAgentConfig = jest.fn() as jest.MockedFunction<
  typeof configDbModule.getSecurityAgentConfig
>;
const mockGetOwnerAutoAnalysisEnabledAt = jest.fn() as jest.MockedFunction<
  typeof analysisDbModule.getOwnerAutoAnalysisEnabledAt
>;
const mockSyncAutoAnalysisQueueForFinding = jest.fn() as jest.MockedFunction<
  typeof analysisDbModule.syncAutoAnalysisQueueForFinding
>;
const mockSupersedeDuplicateFindings = jest.fn() as jest.MockedFunction<
  typeof findingsDbModule.supersedeDuplicateFindings
>;
const mockDequeueSupersededFindings = jest.fn() as jest.MockedFunction<
  typeof analysisDbModule.dequeueSupersededFindings
>;
const mockSyncLogger = jest.fn();
const mockCaptureException = jest.fn();
const mockErrorExceptInTest = jest.fn();
const mockWarnExceptInTest = jest.fn();
let mockIntegrationAuthInvalidAt: string | null = null;
const mockDbLimit = jest.fn(async () => [{ authInvalidAt: mockIntegrationAuthInvalidAt }]);
const mockDbWhereSelect = jest.fn((_condition: unknown) => ({ limit: mockDbLimit }));
const mockDbFrom = jest.fn((_table: unknown) => ({ where: mockDbWhereSelect }));
const mockDbSelect = jest.fn((_selection?: unknown) => ({ from: mockDbFrom }));
const mockDbUpdateWhere = jest.fn(async (_condition: unknown) => undefined);
const mockDbSet = jest.fn((_values: unknown) => ({ where: mockDbUpdateWhere }));
const mockDbUpdate = jest.fn((_table: unknown) => ({ set: mockDbSet }));

jest.mock('../github/dependabot-api', () => ({
  fetchAllDependabotAlerts: mockFetchAllDependabotAlerts,
}));

jest.mock('../parsers/dependabot-parser', () => ({
  parseDependabotAlerts: mockParseDependabotAlerts,
}));

jest.mock('../db/security-findings', () => ({
  upsertSecurityFinding: mockUpsertSecurityFinding,
  supersedeDuplicateFindings: mockSupersedeDuplicateFindings,
}));

jest.mock('../db/security-config', () => ({
  getSecurityAgentConfigWithStatus: mockGetSecurityAgentConfigWithStatus,
  getSecurityAgentConfig: mockGetSecurityAgentConfig,
}));

jest.mock('../db/security-analysis', () => ({
  getOwnerAutoAnalysisEnabledAt: mockGetOwnerAutoAnalysisEnabledAt,
  syncAutoAnalysisQueueForFinding: mockSyncAutoAnalysisQueueForFinding,
  dequeueSupersededFindings: mockDequeueSupersededFindings,
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}));
jest.mock('@kilocode/db/schema', () => ({
  platform_integrations: {
    id: 'platform_integrations.id',
    auth_invalid_at: 'platform_integrations.auth_invalid_at',
  },
  agent_configs: {
    agent_type: 'agent_configs.agent_type',
    platform: 'agent_configs.platform',
    owned_by_organization_id: 'agent_configs.owned_by_organization_id',
    owned_by_user_id: 'agent_configs.owned_by_user_id',
    runtime_state: 'agent_configs.runtime_state',
  },
}));
jest.mock('drizzle-orm', () => ({
  and: jest.fn(() => 'and'),
  eq: jest.fn(() => 'eq'),
  isNotNull: jest.fn(() => 'isNotNull'),
  sql: jest.fn(() => 'sql'),
}));
jest.mock('../github/permissions', () => ({ hasSecurityReviewPermissions: () => true }));
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));
jest.mock('@/lib/utils.server', () => ({
  sentryLogger: () => mockSyncLogger,
  errorExceptInTest: mockErrorExceptInTest,
  warnExceptInTest: mockWarnExceptInTest,
}));
jest.mock('./audit-log-service', () => ({
  logSecurityAudit: jest.fn(),
  SecurityAuditLogAction: { SyncCompleted: 'sync_completed' },
}));
jest.mock('../posthog-tracking', () => ({ trackSecurityAgentFullSync: jest.fn() }));

let syncDependabotAlertsForRepo: typeof syncDependabotAlertsForRepoType;
let syncAllReposForOwner: typeof syncAllReposForOwnerType;

beforeAll(async () => {
  ({ syncAllReposForOwner, syncDependabotAlertsForRepo } = await import('./sync-service'));
});

describe('sync-service queue enqueue wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIntegrationAuthInvalidAt = null;
    mockFetchAllDependabotAlerts.mockResolvedValue({ status: 'success', alerts: [] });
    mockParseDependabotAlerts.mockReturnValue([
      {
        source: 'dependabot',
        source_id: '101',
        severity: 'high',
        ghsa_id: 'GHSA-1',
        cve_id: null,
        package_name: 'lodash',
        package_ecosystem: 'npm',
        vulnerable_version_range: '<4.17.21',
        patched_version: '4.17.21',
        manifest_path: 'package.json',
        title: 'test finding',
        description: 'desc',
        status: 'open',
        ignored_reason: null,
        ignored_by: null,
        fixed_at: null,
        dependabot_html_url: null,
        first_detected_at: '2026-01-01T00:00:00.000Z',
        raw_data: {} as never,
        cwe_ids: null,
        cvss_score: null,
        dependency_scope: 'runtime',
      },
    ]);
    const config: Awaited<ReturnType<typeof mockGetSecurityAgentConfig>> = {
      sla_critical_days: 15,
      sla_high_days: 30,
      sla_medium_days: 45,
      sla_low_days: 90,
      auto_sync_enabled: true,
      repository_selection_mode: 'all',
      model_slug: 'anthropic/claude-opus-4.6',
      analysis_mode: 'auto',
      auto_dismiss_enabled: false,
      auto_dismiss_confidence_threshold: 'high',
      auto_analysis_enabled: true,
      auto_analysis_min_severity: 'high',
      auto_analysis_include_existing: false,
    };
    const configWithStatus: Awaited<ReturnType<typeof mockGetSecurityAgentConfigWithStatus>> = {
      isEnabled: true,
      config,
      storedConfig: config,
    };
    mockGetSecurityAgentConfigWithStatus.mockResolvedValue(configWithStatus);
    mockGetSecurityAgentConfig.mockResolvedValue(config);
    mockGetOwnerAutoAnalysisEnabledAt.mockResolvedValue('2026-01-01T00:00:00.000Z');
    mockUpsertSecurityFinding.mockResolvedValue({
      findingId: 'finding-1',
      wasInserted: true,
      previousStatus: null,
      effectiveStatus: 'open',
      findingCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockSyncAutoAnalysisQueueForFinding.mockResolvedValue({
      enqueueCount: 1,
      eligibleCount: 1,
      boundarySkipCount: 0,
      unknownSeverityCount: 0,
    });
    mockSupersedeDuplicateFindings.mockResolvedValue({
      count: 0,
      supersededFindingIds: [],
    });
    mockDequeueSupersededFindings.mockResolvedValue(0);
  });

  it('passes upsert metadata into auto-analysis queue sync', async () => {
    await syncDependabotAlertsForRepo({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repoFullName: 'acme/repo',
    });

    expect(mockSyncAutoAnalysisQueueForFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        findingId: 'finding-1',
        previousStatus: null,
        currentStatus: 'open',
        findingCreatedAt: '2026-01-01T00:00:00.000Z',
        autoAnalysisEnabled: true,
        isAgentEnabled: true,
      })
    );
  });

  it('uses effectiveStatus (not payload status) so superseded findings are not re-queued', async () => {
    mockUpsertSecurityFinding.mockResolvedValue({
      findingId: 'finding-superseded',
      wasInserted: false,
      previousStatus: 'ignored',
      effectiveStatus: 'ignored',
      findingCreatedAt: '2026-01-01T00:00:00.000Z',
    });

    await syncDependabotAlertsForRepo({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repoFullName: 'acme/repo',
    });

    expect(mockSyncAutoAnalysisQueueForFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        findingId: 'finding-superseded',
        previousStatus: 'ignored',
        currentStatus: 'ignored',
      })
    );
  });

  it('logs queue enqueue observability fields for each sync', async () => {
    await syncDependabotAlertsForRepo({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repoFullName: 'acme/repo',
    });

    expect(mockSyncLogger).toHaveBeenCalledWith(
      'Repo sync complete',
      expect.objectContaining({
        enqueue_count_per_sync: 1,
        eligible_count_per_sync: 1,
        boundary_skip_count: 0,
        unknown_severity_count: 0,
      })
    );
  });

  it('handles all auth_invalid repos without throwing, freshness advancement, or Sentry capture', async () => {
    mockFetchAllDependabotAlerts.mockResolvedValue({ status: 'auth_invalid' });

    await expect(
      syncAllReposForOwner({
        owner: { userId: 'user-1' },
        platformIntegrationId: 'integration-1',
        installationId: 'inst-1',
        repositories: ['acme/widgets', 'acme/api', 'acme/web'],
      })
    ).resolves.toEqual(
      expect.objectContaining({
        errors: 0,
        authInvalid: 1,
        authInvalidRepos: ['acme/widgets'],
        reauthRequired: true,
      })
    );

    expect(mockFetchAllDependabotAlerts).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockDbSet.mock.calls.map(call => call[0])).not.toContainEqual(
      expect.objectContaining({ runtime_state: expect.anything() })
    );
  });

  it('does not advance freshness for mixed success and auth_invalid repos', async () => {
    mockFetchAllDependabotAlerts
      .mockResolvedValueOnce({ status: 'success', alerts: [] })
      .mockResolvedValueOnce({ status: 'auth_invalid' });
    mockParseDependabotAlerts.mockReturnValue([]);

    const result = await syncAllReposForOwner({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repositories: ['acme/widgets', 'acme/api', 'acme/web'],
    });

    expect(result).toEqual(
      expect.objectContaining({
        errors: 0,
        authInvalid: 1,
        reauthRequired: true,
      })
    );
    expect(mockFetchAllDependabotAlerts).toHaveBeenCalledTimes(2);
    expect(mockDbSet.mock.calls.map(call => call[0])).not.toContainEqual(
      expect.objectContaining({ runtime_state: expect.anything() })
    );
  });

  it('marks the installation auth-invalid after a 401-derived fetch result', async () => {
    mockFetchAllDependabotAlerts.mockResolvedValue({ status: 'auth_invalid' });

    await syncAllReposForOwner({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repositories: ['acme/widgets'],
    });

    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_invalid_at: expect.any(String),
        auth_invalid_reason: 'github_dependabot_401',
      })
    );
  });

  it('refreshes expired auth-invalid state after GitHub still returns 401', async () => {
    mockIntegrationAuthInvalidAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockFetchAllDependabotAlerts.mockResolvedValue({ status: 'auth_invalid' });

    const result = await syncAllReposForOwner({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repositories: ['acme/widgets'],
    });

    expect(result).toEqual(
      expect.objectContaining({
        authInvalid: 1,
        authInvalidRepos: ['acme/widgets'],
        reauthRequired: true,
      })
    );
    expect(mockFetchAllDependabotAlerts).toHaveBeenCalledTimes(1);
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        auth_invalid_at: expect.any(String),
        auth_invalid_reason: 'github_dependabot_401',
      })
    );
  });

  it('short-circuits recent auth-invalid installations without GitHub calls', async () => {
    mockIntegrationAuthInvalidAt = new Date().toISOString();

    const result = await syncAllReposForOwner({
      owner: { userId: 'user-1' },
      platformIntegrationId: 'integration-1',
      installationId: 'inst-1',
      repositories: ['acme/widgets', 'acme/api'],
    });

    expect(result).toEqual(
      expect.objectContaining({
        authInvalid: 2,
        authInvalidRepos: ['acme/widgets', 'acme/api'],
        reauthRequired: true,
      })
    );
    expect(mockFetchAllDependabotAlerts).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
