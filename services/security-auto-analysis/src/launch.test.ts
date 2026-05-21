import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import type { WorkerDb } from '@kilocode/db/client';

const {
  mockGetSecurityFindingById,
  mockTryAcquireAnalysisStartLease,
  mockSetFindingPending,
  mockSetFindingCompleted,
  mockSetFindingFailed,
  mockSetFindingRunning,
  mockClearAnalysisStatus,
  mockGenerateApiToken,
  mockTriageSecurityFinding,
} = vi.hoisted(() => ({
  mockGetSecurityFindingById: vi.fn(),
  mockTryAcquireAnalysisStartLease: vi.fn(),
  mockSetFindingPending: vi.fn(),
  mockSetFindingCompleted: vi.fn(),
  mockSetFindingFailed: vi.fn(),
  mockSetFindingRunning: vi.fn(),
  mockClearAnalysisStatus: vi.fn(),
  mockGenerateApiToken: vi.fn(),
  mockTriageSecurityFinding: vi.fn(),
}));

vi.mock('./db/queries.js', () => ({
  getSecurityFindingById: mockGetSecurityFindingById,
  tryAcquireAnalysisStartLease: mockTryAcquireAnalysisStartLease,
  setFindingPending: mockSetFindingPending,
  setFindingCompleted: mockSetFindingCompleted,
  setFindingFailed: mockSetFindingFailed,
  setFindingRunning: mockSetFindingRunning,
  clearAnalysisStatus: mockClearAnalysisStatus,
}));

vi.mock('./token.js', () => ({
  generateApiToken: mockGenerateApiToken,
}));

vi.mock('./triage.js', () => ({
  triageSecurityFinding: mockTriageSecurityFinding,
}));

import { startSecurityAnalysis } from './launch.js';

const INTERNAL_SECRET = 'test-internal-api-secret';
const CALLBACK_SECRET = 'test-callback-token-secret';
const FINDING_ID = 'finding-1';

function finding() {
  return {
    id: FINDING_ID,
    status: 'open',
    repo_full_name: 'owner/repo',
    package_name: 'package',
    package_ecosystem: 'npm',
    severity: 'high',
    dependency_scope: 'runtime',
    cve_id: null,
    ghsa_id: null,
    title: 'Finding',
    description: null,
    vulnerable_version_range: null,
    patched_version: null,
    manifest_path: null,
  };
}

describe('security auto-analysis launch callback target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurityFindingById.mockResolvedValue(finding());
    mockTryAcquireAnalysisStartLease.mockResolvedValue(true);
    mockSetFindingPending.mockResolvedValue(true);
    mockSetFindingCompleted.mockResolvedValue(true);
    mockSetFindingFailed.mockResolvedValue(true);
    mockSetFindingRunning.mockResolvedValue(true);
    mockClearAnalysisStatus.mockResolvedValue(undefined);
    mockGenerateApiToken.mockResolvedValue('api-token');
    mockTriageSecurityFinding.mockResolvedValue({
      needsSandboxAnalysis: true,
      needsSandboxReasoning: 'needs sandbox',
      suggestedAction: 'analyze_codebase',
      confidence: 'high',
      triageAt: '2026-05-20T00:00:00.000Z',
    });
  });

  it('stores scoped callback token instead of raw internal API secret', async () => {
    const requests: Request[] = [];
    const cloudAgentFetch = vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: { data: { cloudAgentSessionId: 'cloud-session-1', kiloSessionId: 'kilo-1' } },
        });
      }
      return Response.json({ result: { data: { executionId: 'exec-1', status: 'running' } } });
    });
    const env = {
      ENVIRONMENT: 'development',
      KILOCODE_BACKEND_BASE_URL: 'https://api.test',
      CLOUD_AGENT_NEXT: { fetch: cloudAgentFetch },
    } as unknown as CloudflareEnv;

    const result = await startSecurityAnalysis({
      db: {} as WorkerDb,
      env,
      findingId: FINDING_ID,
      actorUser: { id: 'user-1', api_token_pepper: null },
      model: 'model-1',
      analysisMode: 'deep',
      nextAuthSecret: 'next-auth-secret',
      internalApiSecret: INTERNAL_SECRET,
      callbackTokenSecret: CALLBACK_SECRET,
    });

    expect(result).toEqual({ started: true, triageOnly: false });
    const prepareBody = await requests[0]?.json();
    const expectedCallbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'security-analysis-callback',
      resourceParts: [FINDING_ID],
    });
    expect(prepareBody).toMatchObject({
      callbackTarget: {
        url: `https://api.test/api/internal/security-analysis-callback/${FINDING_ID}`,
        headers: { 'X-Callback-Token': expectedCallbackToken },
      },
    });
    expect(prepareBody).not.toMatchObject({
      callbackTarget: { headers: { 'X-Internal-Secret': expect.any(String) } },
    });
  });
});
