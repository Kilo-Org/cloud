import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SecurityFinding, User } from '@kilocode/db/schema';
import type * as securityAnalysisModule from '../db/security-analysis';
import type * as securityFindingsModule from '../db/security-findings';
import type * as triageModule from './triage-service';
import type { startSecurityAnalysis as startSecurityAnalysisType } from './analysis-service';
import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { expectNonExchangeableSystemToken } from '@/tests/helpers/system-token.helper';

const mockGetSecurityFindingById = jest.fn<typeof securityFindingsModule.getSecurityFindingById>();
const mockUpdateAnalysisStatus = jest.fn<typeof securityAnalysisModule.updateAnalysisStatus>();
const mockTryAcquireAnalysisStartLease =
  jest.fn<typeof securityAnalysisModule.tryAcquireAnalysisStartLease>();
const mockTriageSecurityFinding = jest.fn<typeof triageModule.triageSecurityFinding>();
const mockPrepareSession = jest.fn<CloudAgentNextClient['prepareSession']>();
const mockInitiateFromPreparedSession =
  jest.fn<CloudAgentNextClient['initiateFromPreparedSession']>();
const mockCleanupSession = jest.fn<CloudAgentNextClient['cleanupSession']>();
const mockCreateCloudAgentNextClient = jest.fn<
  (
    authToken: string
  ) => Pick<
    CloudAgentNextClient,
    'prepareSession' | 'initiateFromPreparedSession' | 'cleanupSession'
  >
>(() => ({
  prepareSession: mockPrepareSession,
  initiateFromPreparedSession: mockInitiateFromPreparedSession,
  cleanupSession: mockCleanupSession,
}));

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));

jest.mock('../db/security-findings', () => ({
  getSecurityFindingById: mockGetSecurityFindingById,
}));

jest.mock('../db/security-analysis', () => ({
  updateAnalysisStatus: mockUpdateAnalysisStatus,
  clearAnalysisStatus: jest.fn(),
  tryAcquireAnalysisStartLease: mockTryAcquireAnalysisStartLease,
}));

jest.mock('./triage-service', () => ({
  triageSecurityFinding: mockTriageSecurityFinding,
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

jest.mock('../posthog-tracking', () => ({
  trackSecurityAgentAnalysisStarted: jest.fn(),
  trackSecurityAgentAnalysisCompleted: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('./auto-dismiss-service', () => ({
  maybeAutoDismissAnalysis: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/utils.server', () => ({
  sentryLogger: () => jest.fn(),
}));

let startSecurityAnalysis: typeof startSecurityAnalysisType;

beforeAll(async () => {
  ({ startSecurityAnalysis } = await import('./analysis-service'));
});

function createFinding(user: User): SecurityFinding {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    owned_by_organization_id: null,
    owned_by_user_id: user.id,
    platform_integration_id: null,
    repo_full_name: 'acme/repo',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
    cve_id: 'CVE-2021-12345',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    vulnerable_version_range: '< 4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    title: 'Prototype Pollution in lodash',
    description: 'A detailed vulnerability description',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    sla_due_at: null,
    dependabot_html_url: null,
    cwe_ids: ['CWE-1321'],
    cvss_score: '7.5',
    dependency_scope: 'runtime',
    session_id: null,
    cli_session_id: null,
    analysis_status: null,
    analysis_started_at: null,
    analysis_completed_at: null,
    analysis_error: null,
    analysis: null,
    raw_data: null,
    first_detected_at: now,
    last_synced_at: now,
    created_at: now,
    updated_at: now,
  };
}

describe('startSecurityAnalysis token source', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTryAcquireAnalysisStartLease.mockResolvedValue(true);
    mockUpdateAnalysisStatus.mockResolvedValue(true);
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Runtime dependency needs repository analysis',
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
      triageAt: new Date().toISOString(),
    });
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent-session-123',
      kiloSessionId: 'kilo-session-123',
    });
    mockInitiateFromPreparedSession.mockResolvedValue({
      cloudAgentSessionId: 'agent-session-123',
      executionId: 'execution-123',
      status: 'started',
      streamUrl: 'wss://example.com/stream',
      messageId: 'message-123',
      delivery: 'sent',
    });
  });

  it('uses one non-exchangeable security-agent token for triage and sandbox analysis', async () => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const finding = createFinding(user);
    mockGetSecurityFindingById.mockResolvedValue(finding);

    const result = await startSecurityAnalysis({
      findingId: finding.id,
      user,
      githubRepo: finding.repo_full_name,
      githubToken: 'github-token',
    });

    expect(result).toEqual({ started: true, triageOnly: false });
    const triageInput = mockTriageSecurityFinding.mock.calls[0]?.[0];
    const cloudAgentToken = mockCreateCloudAgentNextClient.mock.calls[0]?.[0];
    if (!triageInput) throw new Error('Expected triage to receive an input');
    expect(triageInput.authToken).toEqual(expect.any(String));
    expect(cloudAgentToken).toBe(triageInput.authToken);
    await expectNonExchangeableSystemToken(triageInput.authToken, user, 'security-agent');
    expect(mockPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockInitiateFromPreparedSession).toHaveBeenCalledWith({
      cloudAgentSessionId: 'agent-session-123',
    });
  });
});
