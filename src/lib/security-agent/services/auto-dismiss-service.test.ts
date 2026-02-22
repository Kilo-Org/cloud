import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityConfigModule from '@/lib/security-agent/db/security-config';
import type * as platformIntegrationsModule from '@/lib/integrations/db/platform-integrations';
import type * as dependabotApiModule from '@/lib/security-agent/github/dependabot-api';
import type * as posthogModule from '@/lib/security-agent/posthog-tracking';
import type {
  writebackDependabotDismissal as writebackDependabotDismissalType,
  maybeAutoDismissAnalysis as maybeAutoDismissAnalysisType,
} from './auto-dismiss-service';
import type { SecurityFinding } from '@/db/schema';
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
        where: jest.fn(() => []),
      })),
    })),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

let writebackDependabotDismissal: typeof writebackDependabotDismissalType;
let maybeAutoDismissAnalysis: typeof maybeAutoDismissAnalysisType;

beforeAll(async () => {
  ({ writebackDependabotDismissal, maybeAutoDismissAnalysis } = await import(
    './auto-dismiss-service'
  ));
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'finding-1',
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

  it('skips when repo_full_name is invalid', async () => {
    mockGetSecurityFindingById.mockResolvedValue(makeFinding({ repo_full_name: 'no-slash' }));

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
  const sandboxAnalysis: SecurityFindingAnalysis = {
    sandboxAnalysis: {
      isExploitable: false,
      exploitabilityReasoning: 'Not exploitable because dev dependency',
      usageLocations: [],
      suggestedFix: 'Upgrade to latest version',
      suggestedAction: 'dismiss',
      summary: 'Dev dependency, not exploitable',
      rawMarkdown: 'raw',
      analysisAt: '2024-01-01T00:00:00Z',
    },
    analyzedAt: '2024-01-01T00:00:00Z',
  };

  const triageAnalysis: SecurityFindingAnalysis = {
    triage: {
      suggestedAction: 'dismiss',
      confidence: 'high',
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'Dev dependency, not exploitable',
      triageAt: '2024-01-01T00:00:00Z',
    },
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
    expect(mockUpdateSecurityFindingStatus).toHaveBeenCalled();
  });
});
