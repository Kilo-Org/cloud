import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as securityFindingsModule from '@/lib/security-agent/db/security-findings';
import type * as securityAnalysisModule from '@/lib/security-agent/db/security-analysis';
import type * as analysisServiceModule from '@/lib/security-agent/services/analysis-service';
import type * as sessionIngestModule from '@/lib/session-ingest/client';
import type * as posthogModule from '@/lib/security-agent/posthog-tracking';
import type * as tokensModule from '@/lib/tokens';
import type { SecurityFinding, User } from '@/db/schema';
import type { SecurityFindingAnalysis } from '@/lib/security-agent/core/types';

// --- Mock functions ---

const mockGetSecurityFindingById = jest.fn() as jest.MockedFunction<
  typeof securityFindingsModule.getSecurityFindingById
>;
const mockUpdateAnalysisStatus = jest.fn() as jest.MockedFunction<
  typeof securityAnalysisModule.updateAnalysisStatus
>;
const mockFinalizeAnalysis = jest.fn() as jest.MockedFunction<
  typeof analysisServiceModule.finalizeAnalysis
>;
const mockFetchSessionExport = jest.fn() as jest.MockedFunction<
  typeof sessionIngestModule.fetchSessionExport
>;
const mockExtractLastAssistantMessage = jest.fn() as jest.MockedFunction<
  typeof sessionIngestModule.extractLastAssistantMessage
>;
const mockTrackAnalysisCompleted = jest.fn() as jest.MockedFunction<
  typeof posthogModule.trackSecurityAgentAnalysisCompleted
>;
const mockGenerateApiToken = jest.fn() as jest.MockedFunction<typeof tokensModule.generateApiToken>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbSelect = jest.fn<any>();

// --- Module mocks ---

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/security-agent/db/security-findings', () => ({
  getSecurityFindingById: mockGetSecurityFindingById,
}));

jest.mock('@/lib/security-agent/db/security-analysis', () => ({
  updateAnalysisStatus: mockUpdateAnalysisStatus,
}));

jest.mock('@/lib/security-agent/services/analysis-service', () => ({
  finalizeAnalysis: mockFinalizeAnalysis,
}));

jest.mock('@/lib/session-ingest/client', () => ({
  fetchSessionExport: mockFetchSessionExport,
  extractLastAssistantMessage: mockExtractLastAssistantMessage,
}));

jest.mock('@/lib/security-agent/posthog-tracking', () => ({
  trackSecurityAgentAnalysisCompleted: mockTrackAnalysisCompleted,
}));

jest.mock('@/lib/tokens', () => ({
  generateApiToken: mockGenerateApiToken,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/utils.server', () => ({
  sentryLogger: () => jest.fn(),
}));

jest.mock('@/lib/drizzle', () => {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(() => mockDbSelect()),
  };
  return {
    db: {
      select: jest.fn(() => chain),
    },
  };
});

jest.mock('@/db/schema', () => ({
  kilocode_users: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
}));

// --- Helpers ---

const VALID_SECRET = 'test-internal-secret';
const FINDING_ID = 'finding-abc-123';

function makeRequest(
  findingId: string,
  body: Record<string, unknown>,
  secret = VALID_SECRET
): NextRequest {
  return {
    headers: {
      get: (name: string) => (name === 'X-Internal-Secret' ? secret : null),
    },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeParams(findingId: string): { params: Promise<{ findingId: string }> } {
  return { params: Promise.resolve({ findingId }) };
}

const baseAnalysis: SecurityFindingAnalysis = {
  triage: {
    needsSandboxAnalysis: true,
    needsSandboxReasoning: 'Runtime dependency with high severity',
    suggestedAction: 'analyze_codebase',
    confidence: 'high',
    triageAt: '2025-01-01T00:00:00.000Z',
  },
  analyzedAt: '2025-01-01T00:00:00.000Z',
  modelUsed: 'anthropic/claude-sonnet-4',
  triggeredByUserId: 'user-trigger-1',
  correlationId: 'corr-123',
};

function createMockFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: FINDING_ID,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-trigger-1',
    platform_integration_id: null,
    repo_full_name: 'acme/repo',
    source: 'dependabot',
    source_id: '42',
    severity: 'high',
    ghsa_id: 'GHSA-xxxx',
    cve_id: 'CVE-2021-12345',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    vulnerable_version_range: '< 4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    title: 'Prototype Pollution in lodash',
    description: 'A vulnerability in lodash',
    status: 'open',
    ignored_reason: null,
    ignored_by: null,
    fixed_at: null,
    sla_due_at: null,
    dependabot_html_url: null,
    cwe_ids: null,
    cvss_score: null,
    dependency_scope: 'runtime',
    session_id: 'ses-agent-1',
    cli_session_id: null,
    analysis_status: 'running',
    analysis_started_at: '2025-01-01T00:00:00.000Z',
    analysis_completed_at: null,
    analysis_error: null,
    analysis: baseAnalysis,
    raw_data: null,
    first_detected_at: '2025-01-01T00:00:00.000Z',
    last_synced_at: '2025-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const completedPayload = {
  sessionId: 'ses-session-1',
  cloudAgentSessionId: 'agent-session-1',
  executionId: 'exec-1',
  status: 'completed' as const,
  kiloSessionId: 'ses_kilo-1',
};

const failedPayload = {
  sessionId: 'ses-session-1',
  cloudAgentSessionId: 'agent-session-1',
  executionId: 'exec-1',
  status: 'failed' as const,
  errorMessage: 'Sandbox timed out',
};

const interruptedPayload = {
  sessionId: 'ses-session-1',
  cloudAgentSessionId: 'agent-session-1',
  executionId: 'exec-1',
  status: 'interrupted' as const,
  errorMessage: 'User cancelled',
};

// --- Tests ---

let POST: typeof import('./route').POST;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockUpdateAnalysisStatus.mockResolvedValue(undefined);
  mockFinalizeAnalysis.mockResolvedValue(undefined);
  ({ POST } = await import('./route'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('POST /api/internal/security-analysis-callback/[findingId]', () => {
  describe('authentication', () => {
    it('returns 401 when X-Internal-Secret header is missing', async () => {
      const req = makeRequest(FINDING_ID, completedPayload, '');
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 when X-Internal-Secret header is wrong', async () => {
      const req = makeRequest(FINDING_ID, completedPayload, 'wrong-secret');
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('request validation', () => {
    it('returns 400 when status field is missing', async () => {
      const req = makeRequest(FINDING_ID, { sessionId: 'x', cloudAgentSessionId: 'y' });
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Missing required field: status');
    });

    it('returns 404 when finding does not exist', async () => {
      mockGetSecurityFindingById.mockResolvedValue(null);
      const req = makeRequest(FINDING_ID, completedPayload);

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Finding not found');
    });
  });

  describe('idempotency', () => {
    it('skips processing when finding is already completed', async () => {
      mockGetSecurityFindingById.mockResolvedValue(
        createMockFinding({ analysis_status: 'completed' })
      );
      const req = makeRequest(FINDING_ID, completedPayload);

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.currentStatus).toBe('completed');
      expect(mockUpdateAnalysisStatus).not.toHaveBeenCalled();
    });

    it('skips processing when finding is already failed', async () => {
      mockGetSecurityFindingById.mockResolvedValue(
        createMockFinding({ analysis_status: 'failed' })
      );
      const req = makeRequest(FINDING_ID, failedPayload);

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.currentStatus).toBe('failed');
      expect(mockUpdateAnalysisStatus).not.toHaveBeenCalled();
    });
  });

  describe('handleAnalysisCompleted', () => {
    it('fetches session export, writes raw markdown, and calls finalizeAnalysis', async () => {
      const finding = createMockFinding();
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const snapshot = {
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Analysis result markdown' }],
          },
        ],
      };
      mockFetchSessionExport.mockResolvedValue(snapshot);
      mockExtractLastAssistantMessage.mockReturnValue('Analysis result markdown');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);

      // Verify session export was fetched with correct args
      expect(mockFetchSessionExport).toHaveBeenCalledWith('ses_kilo-1', 'user-trigger-1');

      // Verify raw markdown was written to analysis field
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(
        FINDING_ID,
        'running',
        expect.objectContaining({
          analysis: expect.objectContaining({ rawMarkdown: 'Analysis result markdown' }),
        })
      );

      // Verify finalizeAnalysis was called with correct args
      expect(mockFinalizeAnalysis).toHaveBeenCalledWith(
        FINDING_ID,
        'Analysis result markdown',
        'anthropic/claude-sonnet-4',
        { userId: 'user-trigger-1' }, // owner derived from owned_by_user_id
        'user-trigger-1',
        'fresh-token',
        'corr-123',
        undefined // no organization
      );
    });

    it('passes organizationId to finalizeAnalysis when finding is org-owned', async () => {
      const orgId = 'org-uuid-123';
      const finding = createMockFinding({
        owned_by_organization_id: orgId,
        owned_by_user_id: null,
      });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      mockFetchSessionExport.mockResolvedValue({
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Org analysis' }],
          },
        ],
      });
      mockExtractLastAssistantMessage.mockReturnValue('Org analysis');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      await POST(req, makeParams(FINDING_ID));

      expect(mockFinalizeAnalysis).toHaveBeenCalledWith(
        FINDING_ID,
        'Org analysis',
        'anthropic/claude-sonnet-4',
        { organizationId: orgId }, // owner is org-based
        'user-trigger-1',
        'fresh-token',
        'corr-123',
        orgId
      );
    });

    it('marks finding failed when triggeredByUserId is missing from analysis context', async () => {
      const finding = createMockFinding({
        analysis: { ...baseAnalysis, triggeredByUserId: undefined },
      });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const req = makeRequest(FINDING_ID, completedPayload);
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Cannot process callback — triggeredByUserId missing from analysis context',
      });
      expect(mockFetchSessionExport).not.toHaveBeenCalled();
    });

    it('marks finding failed when callback payload is missing kiloSessionId', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      const payloadWithoutSessionId = { ...completedPayload, kiloSessionId: undefined };
      const req = makeRequest(FINDING_ID, payloadWithoutSessionId);
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Callback missing kiloSessionId — cannot retrieve analysis result',
      });
    });

    it('retries session export fetch when first attempt returns no result', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      const snapshot = {
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Delayed result' }],
          },
        ],
      };

      // First attempt: no snapshot, second attempt: success
      mockFetchSessionExport.mockResolvedValueOnce(null).mockResolvedValueOnce(snapshot);
      mockExtractLastAssistantMessage.mockReturnValue('Delayed result');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      const responsePromise = POST(req, makeParams(FINDING_ID));

      // Advance past the retry delay
      await jest.advanceTimersByTimeAsync(5000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(mockFetchSessionExport).toHaveBeenCalledTimes(2);
      expect(mockFinalizeAnalysis).toHaveBeenCalled();
    });

    it('retries when fetchSessionExport throws on first attempt', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      const snapshot = {
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Eventually got it' }],
          },
        ],
      };

      // First attempt throws, second succeeds
      mockFetchSessionExport
        .mockRejectedValueOnce(new Error('Ingest service unavailable'))
        .mockResolvedValueOnce(snapshot);
      mockExtractLastAssistantMessage.mockReturnValue('Eventually got it');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      const responsePromise = POST(req, makeParams(FINDING_ID));

      await jest.advanceTimersByTimeAsync(5000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(mockFetchSessionExport).toHaveBeenCalledTimes(2);
      expect(mockFinalizeAnalysis).toHaveBeenCalled();
    });

    it('marks finding failed after all retry attempts are exhausted', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      // All 3 attempts return null
      mockFetchSessionExport.mockResolvedValue(null);
      mockExtractLastAssistantMessage.mockReturnValue(null);

      const req = makeRequest(FINDING_ID, completedPayload);
      const responsePromise = POST(req, makeParams(FINDING_ID));

      // Advance past all retry delays (2 retries × 5s)
      await jest.advanceTimersByTimeAsync(10000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(mockFetchSessionExport).toHaveBeenCalledTimes(3);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Analysis completed but result could not be retrieved from ingest service',
      });
      expect(mockFinalizeAnalysis).not.toHaveBeenCalled();
    });

    it('marks finding failed when user is not found in DB', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());

      mockFetchSessionExport.mockResolvedValue({
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Result' }],
          },
        ],
      });
      mockExtractLastAssistantMessage.mockReturnValue('Result');

      // User not found in DB
      mockDbSelect.mockResolvedValue([]);

      const req = makeRequest(FINDING_ID, completedPayload);
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'User user-trigger-1 not found — cannot run Tier 3 extraction',
      });
      expect(mockFinalizeAnalysis).not.toHaveBeenCalled();
    });

    it('preserves existing analysis fields when writing raw markdown', async () => {
      const finding = createMockFinding();
      mockGetSecurityFindingById.mockResolvedValue(finding);

      mockFetchSessionExport.mockResolvedValue({
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'New markdown' }],
          },
        ],
      });
      mockExtractLastAssistantMessage.mockReturnValue('New markdown');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      await POST(req, makeParams(FINDING_ID));

      // The update should merge existing analysis fields (triage, modelUsed, etc.)
      // with the new rawMarkdown
      const updateCall = mockUpdateAnalysisStatus.mock.calls.find(call => call[1] === 'running');
      if (!updateCall) throw new Error('Expected updateAnalysisStatus to be called with running');
      const updates = updateCall[2];
      if (!updates) throw new Error('Expected third argument to updateAnalysisStatus');
      const analysisArg = updates.analysis;
      expect(analysisArg).toMatchObject({
        triage: baseAnalysis.triage,
        modelUsed: baseAnalysis.modelUsed,
        triggeredByUserId: baseAnalysis.triggeredByUserId,
        correlationId: baseAnalysis.correlationId,
        rawMarkdown: 'New markdown',
      });
    });

    it('uses default model when modelUsed is missing from analysis context', async () => {
      const finding = createMockFinding({
        analysis: { ...baseAnalysis, modelUsed: undefined },
      });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      mockFetchSessionExport.mockResolvedValue({
        info: {},
        messages: [
          {
            info: { id: 'msg-1', role: 'assistant' },
            parts: [{ id: 'p-1', type: 'text', text: 'Result' }],
          },
        ],
      });
      mockExtractLastAssistantMessage.mockReturnValue('Result');

      const mockUser = { id: 'user-trigger-1', api_token_pepper: 'pepper' } as User;
      mockDbSelect.mockResolvedValue([mockUser]);
      mockGenerateApiToken.mockReturnValue('fresh-token');

      const req = makeRequest(FINDING_ID, completedPayload);
      await POST(req, makeParams(FINDING_ID));

      // Should use default model
      expect(mockFinalizeAnalysis).toHaveBeenCalledWith(
        FINDING_ID,
        'Result',
        'anthropic/claude-sonnet-4',
        expect.anything(),
        'user-trigger-1',
        'fresh-token',
        expect.any(String),
        undefined
      );
    });
  });

  describe('handleAnalysisFailed', () => {
    it('marks finding as failed with error message', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());
      const req = makeRequest(FINDING_ID, failedPayload);

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Sandbox timed out',
      });
    });

    it('marks finding as failed with prefixed message for interrupted status', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());
      const req = makeRequest(FINDING_ID, interruptedPayload);

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Analysis interrupted: User cancelled',
      });
    });

    it('uses default message when errorMessage is absent for failed status', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());
      const req = makeRequest(FINDING_ID, { ...failedPayload, errorMessage: undefined });

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Analysis failed',
      });
    });

    it('uses default reason when errorMessage is absent for interrupted status', async () => {
      mockGetSecurityFindingById.mockResolvedValue(createMockFinding());
      const req = makeRequest(FINDING_ID, { ...interruptedPayload, errorMessage: undefined });

      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(200);
      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Analysis interrupted: unknown reason',
      });
    });

    it('tracks PostHog failure event with analysis duration', async () => {
      const startedAt = new Date('2025-01-01T00:00:00.000Z');
      const finding = createMockFinding({ analysis_started_at: startedAt.toISOString() });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const req = makeRequest(FINDING_ID, failedPayload);
      await POST(req, makeParams(FINDING_ID));

      expect(mockTrackAnalysisCompleted).toHaveBeenCalledWith({
        distinctId: 'user-trigger-1',
        userId: 'user-trigger-1',
        organizationId: undefined,
        findingId: FINDING_ID,
        model: 'anthropic/claude-sonnet-4',
        triageOnly: false,
        durationMs: expect.any(Number),
      });
    });

    it('skips PostHog tracking when triggeredByUserId is missing', async () => {
      const finding = createMockFinding({
        analysis: { ...baseAnalysis, triggeredByUserId: undefined },
      });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const req = makeRequest(FINDING_ID, failedPayload);
      await POST(req, makeParams(FINDING_ID));

      expect(mockUpdateAnalysisStatus).toHaveBeenCalledWith(FINDING_ID, 'failed', {
        error: 'Sandbox timed out',
      });
      expect(mockTrackAnalysisCompleted).not.toHaveBeenCalled();
    });

    it('includes organizationId in PostHog event for org-owned findings', async () => {
      const orgId = 'org-uuid-456';
      const finding = createMockFinding({
        owned_by_organization_id: orgId,
        owned_by_user_id: null,
      });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const req = makeRequest(FINDING_ID, failedPayload);
      await POST(req, makeParams(FINDING_ID));

      expect(mockTrackAnalysisCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId })
      );
    });

    it('computes durationMs as 0 when analysis_started_at is null', async () => {
      const finding = createMockFinding({ analysis_started_at: null });
      mockGetSecurityFindingById.mockResolvedValue(finding);

      const req = makeRequest(FINDING_ID, failedPayload);
      await POST(req, makeParams(FINDING_ID));

      expect(mockTrackAnalysisCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ durationMs: 0 })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 and captures exception when an unexpected error occurs', async () => {
      mockGetSecurityFindingById.mockRejectedValue(new Error('DB connection failed'));

      const req = makeRequest(FINDING_ID, completedPayload);
      const response = await POST(req, makeParams(FINDING_ID));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to process callback');
      expect(body.message).toBe('DB connection failed');
    });
  });
});
