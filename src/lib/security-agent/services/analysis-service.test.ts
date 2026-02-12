import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityAnalysisModule from '@/lib/security-agent/db/security-analysis';
import type * as triageModule from './triage-service';
import type * as tokensModule from '@/lib/tokens';
import type { StreamEvent } from '@/components/cloud-agent/types';
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
const mockInitiateSessionStream = jest.fn() as jest.MockedFunction<
  (input: unknown) => AsyncGenerator<StreamEvent, void, unknown>
>;

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

jest.mock('@/lib/cloud-agent/cloud-agent-client', () => ({
  createCloudAgentClient: jest.fn(() => ({
    initiateSessionStream: mockInitiateSessionStream,
  })),
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

  it('passes organization id to cloud agent sandbox analysis', async () => {
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
    mockInitiateSessionStream.mockReturnValue((async function* () {})());

    const result = await startSecurityAnalysis({
      findingId,
      user,
      githubRepo: 'acme/repo',
      githubToken: 'gh-token',
      model: 'anthropic/claude-sonnet-4',
      organizationId,
    });

    expect(result.started).toBe(true);
    expect(mockInitiateSessionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        kilocodeOrganizationId: organizationId,
      })
    );
  });
});
