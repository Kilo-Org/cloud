import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as dependabotApiModule from '../github/dependabot-api';
import type * as parserModule from '../parsers/dependabot-parser';
import type * as findingsDbModule from '../db/security-findings';
import type * as configDbModule from '../db/security-config';
import type * as analysisDbModule from '../db/security-analysis';
import type { syncDependabotAlertsForRepo as syncDependabotAlertsForRepoType } from './sync-service';

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
const mockSyncLogger = jest.fn();

jest.mock('../github/dependabot-api', () => ({
  fetchAllDependabotAlerts: mockFetchAllDependabotAlerts,
}));

jest.mock('../parsers/dependabot-parser', () => ({
  parseDependabotAlerts: mockParseDependabotAlerts,
}));

jest.mock('../db/security-findings', () => ({
  upsertSecurityFinding: mockUpsertSecurityFinding,
}));

jest.mock('../db/security-config', () => ({
  getSecurityAgentConfigWithStatus: mockGetSecurityAgentConfigWithStatus,
  getSecurityAgentConfig: mockGetSecurityAgentConfig,
}));

jest.mock('../db/security-analysis', () => ({
  getOwnerAutoAnalysisEnabledAt: mockGetOwnerAutoAnalysisEnabledAt,
  syncAutoAnalysisQueueForFinding: mockSyncAutoAnalysisQueueForFinding,
}));

jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@kilocode/db/schema', () => ({ platform_integrations: {}, agent_configs: {} }));
jest.mock('../github/permissions', () => ({ hasSecurityReviewPermissions: () => true }));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: () => mockSyncLogger }));
jest.mock('./audit-log-service', () => ({
  logSecurityAudit: jest.fn(),
  SecurityAuditLogAction: { SyncCompleted: 'sync_completed' },
}));
jest.mock('../posthog-tracking', () => ({ trackSecurityAgentFullSync: jest.fn() }));

let syncDependabotAlertsForRepo: typeof syncDependabotAlertsForRepoType;

beforeAll(async () => {
  ({ syncDependabotAlertsForRepo } = await import('./sync-service'));
});

describe('sync-service queue enqueue wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      findingCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockSyncAutoAnalysisQueueForFinding.mockResolvedValue({
      enqueueCount: 1,
      eligibleCount: 1,
      boundarySkipCount: 0,
      unknownSeverityCount: 0,
    });
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
        findingCreatedAt: '2026-01-01T00:00:00.000Z',
        autoAnalysisEnabled: true,
        isAgentEnabled: true,
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
});
