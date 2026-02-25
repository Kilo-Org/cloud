import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityAnalysisModule from '@/lib/security-agent/db/security-analysis';
import type * as triageModule from './triage-service';
import type * as tokensModule from '@/lib/tokens';
import type { User } from '@/db/schema';
import type { SessionSnapshot } from '@/lib/session-ingest-client';
import type { startSecurityAnalysis as startSecurityAnalysisType } from './analysis-service';
import type { extractLastAssistantMessage as extractLastAssistantMessageType } from './analysis-service';

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
let extractLastAssistantMessage: typeof extractLastAssistantMessageType;

beforeAll(async () => {
  ({ startSecurityAnalysis, extractLastAssistantMessage } = await import('./analysis-service'));
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

// ---------------------------------------------------------------------------
// extractLastAssistantMessage (pure function, no mocks needed)
// ---------------------------------------------------------------------------

function makeSnapshot(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string; id?: string }>;
  }>
): SessionSnapshot {
  return {
    info: {},
    messages: messages.map((m, i) => ({
      info: { id: `msg_${i}`, role: m.role },
      parts: m.parts.map((p, j) => ({
        id: p.id ?? `part_${i}_${j}`,
        type: p.type,
        ...(p.text !== undefined ? { text: p.text } : {}),
      })),
    })),
  };
}

describe('extractLastAssistantMessage', () => {
  it('returns null for empty messages', () => {
    expect(extractLastAssistantMessage(makeSnapshot([]))).toBeNull();
  });

  it('returns null when no assistant messages exist', () => {
    const snapshot = makeSnapshot([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]);
    expect(extractLastAssistantMessage(snapshot)).toBeNull();
  });

  it('extracts text from a single assistant message', () => {
    const snapshot = makeSnapshot([
      { role: 'user', parts: [{ type: 'text', text: 'analyze this' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'The analysis shows...' }] },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('The analysis shows...');
  });

  it('returns the last assistant message when multiple exist', () => {
    const snapshot = makeSnapshot([
      { role: 'user', parts: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', text: 'second question' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('second answer');
  });

  it('concatenates multiple text parts', () => {
    const snapshot = makeSnapshot([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('Part one. Part two.');
  });

  it('skips non-text parts (tool calls, step-finish, etc.)', () => {
    const snapshot = makeSnapshot([
      {
        role: 'assistant',
        parts: [
          { type: 'tool', text: undefined },
          { type: 'text', text: 'The result is clear.' },
          { type: 'step-finish' },
        ],
      },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('The result is clear.');
  });

  it('skips assistant messages with empty text and returns earlier one', () => {
    const snapshot = makeSnapshot([
      { role: 'assistant', parts: [{ type: 'text', text: 'Earlier answer with content.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'followup' }] },
      { role: 'assistant', parts: [{ type: 'tool' }] },
    ]);
    expect(extractLastAssistantMessage(snapshot)).toBe('Earlier answer with content.');
  });

  it('skips parts where text is not a string', () => {
    const snapshot: SessionSnapshot = {
      info: {},
      messages: [
        {
          info: { id: 'msg_0', role: 'assistant' },
          parts: [
            { id: 'p1', type: 'text', text: undefined as unknown as string },
            { id: 'p2', type: 'text', text: 'valid text' },
          ],
        },
      ],
    };
    expect(extractLastAssistantMessage(snapshot)).toBe('valid text');
  });
});
