import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityAnalysisModule from '@/lib/security-agent/db/security-analysis';
import type * as triageModule from './triage-service';
import type * as tokensModule from '@/lib/tokens';
import type { User } from '@/db/schema';
import type { startSecurityAnalysis as startSecurityAnalysisType } from './analysis-service';

const mockGetSecurityFindingById = jest.fn() as jest.MockedFunction<
  typeof securityFindingsModule.getSecurityFindingById
>;
const mockUpdateAnalysisStatus = jest.fn() as jest.MockedFunction<
  typeof securityAnalysisModule.updateAnalysisStatus
>;
const mockTriageSecurityFinding = jest.fn() as jest.MockedFunction<
  typeof triageModule.triageSecurityFinding
>;
const mockGenerateApiToken = jest.fn() as jest.MockedFunction<typeof tokensModule.generateApiToken>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrepareSession = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInitiateFromPreparedSession = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDeleteSession = jest.fn<any>();

jest.mock('@/lib/security-agent/db/security-findings', () => ({
  getSecurityFindingById: mockGetSecurityFindingById,
}));

jest.mock('@/lib/security-agent/db/security-analysis', () => ({
  updateAnalysisStatus: mockUpdateAnalysisStatus,
}));

jest.mock('./triage-service', () => ({
  triageSecurityFinding: mockTriageSecurityFinding,
}));

jest.mock('@/lib/tokens', () => ({
  generateApiToken: mockGenerateApiToken,
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    prepareSession: mockPrepareSession,
    initiateFromPreparedSession: mockInitiateFromPreparedSession,
    deleteSession: mockDeleteSession,
  })),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    readonly httpStatus = 402;
    readonly code = 'PAYMENT_REQUIRED';
    constructor(message = 'Insufficient credits') {
      super(message);
      this.name = 'InsufficientCreditsError';
    }
  },
}));

jest.mock('./auto-dismiss-service', () => ({
  maybeAutoDismissAnalysis: jest.fn(() => Promise.resolve()),
}));

jest.mock('./extraction-service', () => ({
  extractSandboxAnalysis: jest.fn(() => Promise.resolve()),
}));

let startSecurityAnalysis: typeof startSecurityAnalysisType;

beforeAll(async () => {
  ({ startSecurityAnalysis } = await import('./analysis-service'));
});

describe('analysis-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes organization id to cloud-agent-next prepareSession', async () => {
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const findingId = 'finding-123';
    const user = { id: 'user-1', google_user_email: 'test@example.com' } as User;

    const mockFinding = {
      id: findingId,
      analysis_status: 'new',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'high',
      dependency_scope: 'runtime',
      cve_id: 'CVE-2021-12345',
      ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
      title: 'Prototype Pollution in lodash',
      description: 'A detailed description of the vulnerability',
      vulnerable_version_range: '< 4.17.21',
      patched_version: '4.17.21',
      manifest_path: 'package.json',
    };

    mockGetSecurityFindingById.mockResolvedValue(
      mockFinding as Awaited<ReturnType<typeof mockGetSecurityFindingById>>
    );
    mockUpdateAnalysisStatus.mockResolvedValue(undefined);
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Runtime dependency with high severity',
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
      triageAt: new Date().toISOString(),
    });
    mockGenerateApiToken.mockReturnValue('test-token');
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'ses-agent-123',
      kiloSessionId: 'ses_kilo-123',
    });
    mockInitiateFromPreparedSession.mockResolvedValue({
      cloudAgentSessionId: 'ses-agent-123',
      executionId: 'exec-123',
      status: 'started',
      streamUrl: 'wss://example.com/stream',
    });

    const result = await startSecurityAnalysis({
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
      model: 'anthropic/claude-sonnet-4',
      organizationId,
    });

    expect(result.started).toBe(true);
    expect(result.triageOnly).toBe(false);
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kilocodeOrganizationId: organizationId,
        githubRepo: 'acme/repo',
        githubToken: 'gh-token',
        mode: 'code',
        model: 'anthropic/claude-sonnet-4',
        callbackTarget: expect.objectContaining({
          url: expect.stringContaining(`/api/internal/security-analysis-callback/${findingId}`),
          headers: expect.objectContaining({ 'X-Internal-Secret': expect.any(String) }),
        }),
      })
    );
    expect(mockInitiateFromPreparedSession).toHaveBeenCalledWith({
      cloudAgentSessionId: 'ses-agent-123',
    });
  });

  it('stores session IDs after prepareSession', async () => {
    const findingId = 'finding-456';
    const user = { id: 'user-1', google_user_email: 'test@example.com' } as User;

    const mockFinding = {
      id: findingId,
      analysis_status: 'new',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'high',
      dependency_scope: 'runtime',
      cve_id: null,
      ghsa_id: null,
      title: 'Test vulnerability',
      description: null,
      vulnerable_version_range: null,
      patched_version: null,
      manifest_path: null,
    };

    mockGetSecurityFindingById.mockResolvedValue(
      mockFinding as Awaited<ReturnType<typeof mockGetSecurityFindingById>>
    );
    mockUpdateAnalysisStatus.mockResolvedValue(undefined);
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Needs analysis',
      suggestedAction: 'analyze_codebase',
      confidence: 'medium',
      triageAt: new Date().toISOString(),
    });
    mockGenerateApiToken.mockReturnValue('test-token');
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent-session-abc',
      kiloSessionId: 'ses_kilo-abc',
    });
    mockInitiateFromPreparedSession.mockResolvedValue({
      cloudAgentSessionId: 'agent-session-abc',
      executionId: 'exec-abc',
      status: 'started',
      streamUrl: 'wss://example.com/stream',
    });

    await startSecurityAnalysis({
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
    });

    // Verify session IDs were stored via updateAnalysisStatus('running', ...)
    expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(findingId, 'running', {
      sessionId: 'agent-session-abc',
      cliSessionId: 'ses_kilo-abc',
    });
  });

  it('returns triageOnly when sandbox analysis is not needed', async () => {
    const findingId = 'finding-triage';
    const user = { id: 'user-1', google_user_email: 'test@example.com' } as User;

    const mockFinding = {
      id: findingId,
      analysis_status: 'new',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'low',
      dependency_scope: 'development',
      cve_id: null,
      ghsa_id: null,
      title: 'Low severity dev dep',
      description: null,
      vulnerable_version_range: null,
      patched_version: null,
      manifest_path: null,
    };

    mockGetSecurityFindingById.mockResolvedValue(
      mockFinding as Awaited<ReturnType<typeof mockGetSecurityFindingById>>
    );
    mockUpdateAnalysisStatus.mockResolvedValue(undefined);
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'Dev dependency, low severity',
      suggestedAction: 'dismiss',
      confidence: 'high',
      triageAt: new Date().toISOString(),
    });
    mockGenerateApiToken.mockReturnValue('test-token');

    const result = await startSecurityAnalysis({
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
    });

    expect(result.started).toBe(true);
    expect(result.triageOnly).toBe(true);
    // prepareSession should NOT be called for triage-only
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('handles initiateFromPreparedSession failure and cleans up', async () => {
    const findingId = 'finding-fail';
    const user = { id: 'user-1', google_user_email: 'test@example.com' } as User;

    const mockFinding = {
      id: findingId,
      analysis_status: 'new',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'high',
      dependency_scope: 'runtime',
      cve_id: null,
      ghsa_id: null,
      title: 'Test vulnerability',
      description: null,
      vulnerable_version_range: null,
      patched_version: null,
      manifest_path: null,
    };

    mockGetSecurityFindingById.mockResolvedValue(
      mockFinding as Awaited<ReturnType<typeof mockGetSecurityFindingById>>
    );
    mockUpdateAnalysisStatus.mockResolvedValue(undefined);
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'Needs analysis',
      suggestedAction: 'analyze_codebase',
      confidence: 'medium',
      triageAt: new Date().toISOString(),
    });
    mockGenerateApiToken.mockReturnValue('test-token');
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent-session-xyz',
      kiloSessionId: 'ses_kilo-xyz',
    });
    mockInitiateFromPreparedSession.mockRejectedValue(new Error('Sandbox unavailable'));
    mockDeleteSession.mockResolvedValue({ success: true });

    const result = await startSecurityAnalysis({
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
    });

    expect(result.started).toBe(false);
    expect(result.error).toBe('Sandbox unavailable');
    // Should attempt to clean up the prepared session
    expect(mockDeleteSession).toHaveBeenCalledWith('agent-session-xyz');
    // Should mark finding as failed
    expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(findingId, 'failed', {
      error: 'Sandbox unavailable',
    });
  });

  describe('analysis_mode', () => {
    const findingId = 'finding-mode-test';
    const user = { id: 'user-1', google_user_email: 'test@example.com' } as User;

    const mockFinding = {
      id: findingId,
      analysis_status: 'new',
      repo_full_name: 'acme/repo',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      severity: 'high',
      dependency_scope: 'runtime',
      cve_id: 'CVE-2021-12345',
      ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
      title: 'Prototype Pollution in lodash',
      description: 'A detailed description of the vulnerability',
      vulnerable_version_range: '< 4.17.21',
      patched_version: '4.17.21',
      manifest_path: 'package.json',
    };

    const baseParams = {
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
      model: 'anthropic/claude-sonnet-4' as const,
    };

    beforeEach(() => {
      mockGetSecurityFindingById.mockResolvedValue(
        mockFinding as Awaited<ReturnType<typeof mockGetSecurityFindingById>>
      );
      mockUpdateAnalysisStatus.mockResolvedValue(undefined);
      mockGenerateApiToken.mockReturnValue('test-token');
      mockPrepareSession.mockResolvedValue({
        cloudAgentSessionId: 'ses-agent-mode',
        kiloSessionId: 'ses_kilo-mode',
      });
      mockInitiateFromPreparedSession.mockResolvedValue({
        cloudAgentSessionId: 'ses-agent-mode',
        executionId: 'exec-mode',
        status: 'started',
        streamUrl: 'wss://example.com/stream',
      });
    });

    it('auto mode: runs sandbox when triage recommends it', async () => {
      mockTriageSecurityFinding.mockResolvedValue({
        needsSandboxAnalysis: true,
        needsSandboxReasoning: 'Runtime dependency with high severity',
        suggestedAction: 'analyze_codebase',
        confidence: 'high',
        triageAt: new Date().toISOString(),
      });

      const result = await startSecurityAnalysis({
        ...baseParams,
        analysisMode: 'auto',
      });

      expect(result.started).toBe(true);
      expect(result.triageOnly).toBe(false);
      expect(mockTriageSecurityFinding).toHaveBeenCalled();
      expect(mockPrepareSession).toHaveBeenCalled();
    });

    it('auto mode: skips sandbox when triage says not needed', async () => {
      mockTriageSecurityFinding.mockResolvedValue({
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Dev dependency, low risk',
        suggestedAction: 'dismiss',
        confidence: 'high',
        triageAt: new Date().toISOString(),
      });

      const result = await startSecurityAnalysis({
        ...baseParams,
        analysisMode: 'auto',
      });

      expect(result.started).toBe(true);
      expect(result.triageOnly).toBe(true);
      expect(mockTriageSecurityFinding).toHaveBeenCalled();
      expect(mockPrepareSession).not.toHaveBeenCalled();
    });

    it('shallow mode: never runs sandbox even when triage recommends it', async () => {
      mockTriageSecurityFinding.mockResolvedValue({
        needsSandboxAnalysis: true,
        needsSandboxReasoning: 'Runtime dependency with high severity',
        suggestedAction: 'analyze_codebase',
        confidence: 'high',
        triageAt: new Date().toISOString(),
      });

      const result = await startSecurityAnalysis({
        ...baseParams,
        analysisMode: 'shallow',
      });

      expect(result.started).toBe(true);
      expect(result.triageOnly).toBe(true);
      expect(mockTriageSecurityFinding).toHaveBeenCalled();
      expect(mockPrepareSession).not.toHaveBeenCalled();
    });

    it('deep mode: always runs sandbox even when triage says not needed', async () => {
      mockTriageSecurityFinding.mockResolvedValue({
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Dev dependency, low risk',
        suggestedAction: 'dismiss',
        confidence: 'high',
        triageAt: new Date().toISOString(),
      });

      const result = await startSecurityAnalysis({
        ...baseParams,
        analysisMode: 'deep',
      });

      expect(result.started).toBe(true);
      expect(result.triageOnly).toBe(false);
      expect(mockTriageSecurityFinding).toHaveBeenCalled();
      expect(mockPrepareSession).toHaveBeenCalled();
    });

    it('defaults to auto mode when analysisMode is not specified', async () => {
      mockTriageSecurityFinding.mockResolvedValue({
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Dev dependency',
        suggestedAction: 'dismiss',
        confidence: 'high',
        triageAt: new Date().toISOString(),
      });

      const result = await startSecurityAnalysis(baseParams);

      expect(result.started).toBe(true);
      expect(result.triageOnly).toBe(true);
      expect(mockPrepareSession).not.toHaveBeenCalled();
    });
  });
});
