import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import {
  clearAnalysisStatus,
  getSecurityFindingById,
  setFindingCompleted,
  setFindingFailed,
  setFindingPending,
  setFindingRunning,
  tryAcquireAnalysisStartLease,
} from './db/queries.js';
import { buildSecurityAnalysisCallbackTarget, startSecurityAnalysis } from './launch.js';
import { generateApiToken } from './token.js';
import { triageSecurityFinding } from './triage.js';

vi.mock('./db/queries.js', () => ({
  clearAnalysisStatus: vi.fn(),
  getSecurityFindingById: vi.fn(),
  setFindingCompleted: vi.fn(),
  setFindingFailed: vi.fn(),
  setFindingPending: vi.fn(),
  setFindingRunning: vi.fn(),
  tryAcquireAnalysisStartLease: vi.fn(),
}));
vi.mock('./token.js', () => ({ generateApiToken: vi.fn() }));
vi.mock('./triage.js', () => ({ triageSecurityFinding: vi.fn() }));

const CALLBACK_SECRET = 'test-callback-token-secret';

const finding = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  platform_integration_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repo_full_name: 'kilo/repo',
  source: 'dependabot',
  source_id: '42',
  created_at: '2026-05-18T08:00:00.000Z',
  status: 'open',
  severity: 'high',
  package_name: 'package-name',
  package_ecosystem: 'npm',
  dependency_scope: 'runtime',
  cve_id: null,
  ghsa_id: null,
  title: 'Finding title',
  description: 'Finding description',
  vulnerable_version_range: '<1.0.0',
  patched_version: '1.0.0',
  manifest_path: 'package.json',
  raw_data: null,
  analysis_status: 'failed',
  analysis_started_at: null,
  session_id: null,
  cli_session_id: null,
  ignored_reason: null,
  owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owned_by_user_id: null,
};

const existingTriage = {
  needsSandboxAnalysis: true,
  needsSandboxReasoning: 'Existing triage requests sandbox.',
  suggestedAction: 'analyze_codebase' as const,
  confidence: 'high' as const,
  triageAt: '2026-05-18T08:00:00.000Z',
};

function createParams(retrySandboxOnly: boolean, cloudAgentFetch: typeof fetch) {
  return {
    db: {} as never,
    env: {
      ENVIRONMENT: 'development',
      KILOCODE_BACKEND_BASE_URL: 'https://backend.test',
      SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
      SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
      SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: 'https://security-analysis.test',
      CLOUD_AGENT_NEXT: { fetch: cloudAgentFetch },
    } as unknown as CloudflareEnv,
    findingId: finding.id,
    actorUser: { id: 'user-123', api_token_pepper: null },
    githubToken: 'github-token',
    triageModel: 'triage/model',
    analysisModel: 'analysis/model',
    analysisMode: 'auto' as const,
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    nextAuthSecret: 'next-auth-secret',
    internalApiSecret: 'internal-api-secret',
    callbackTokenSecret: CALLBACK_SECRET,
    retrySandboxOnly,
  };
}

describe('buildSecurityAnalysisCallbackTarget', () => {
  it('routes callback delivery to configured Worker HTTP ingress', () => {
    expect(
      buildSecurityAnalysisCallbackTarget(
        {
          SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
          SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
          SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: 'https://security-analysis.test/',
        },
        finding.id,
        'callback-token'
      )
    ).toEqual({
      url: `https://security-analysis.test/internal/security-analysis-callback/${finding.id}`,
      headers: { 'X-Callback-Token': 'callback-token' },
    });
  });

  it('routes callback delivery through the compatibility web ingress when configured', () => {
    expect(
      buildSecurityAnalysisCallbackTarget(
        {
          SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'web',
          SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai/',
          SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: '',
        },
        finding.id,
        'callback-token'
      )
    ).toEqual({
      url: `https://app.kilo.ai/api/internal/security-analysis-callback/${finding.id}`,
      headers: { 'X-Callback-Token': 'callback-token' },
    });
  });

  it('requires a public Worker base URL for Worker callback routing', () => {
    expect(() =>
      buildSecurityAnalysisCallbackTarget(
        {
          SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
          SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
          SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: '',
        },
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'callback-token'
      )
    ).toThrow('SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL');
  });
});

describe('startSecurityAnalysis retrySandboxOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tryAcquireAnalysisStartLease).mockResolvedValue(true);
    vi.mocked(generateApiToken).mockResolvedValue('auth-token');
    vi.mocked(setFindingCompleted).mockResolvedValue(true);
    vi.mocked(setFindingFailed).mockResolvedValue(true);
    vi.mocked(setFindingPending).mockResolvedValue(true);
    vi.mocked(setFindingRunning).mockResolvedValue(true);
    vi.mocked(clearAnalysisStatus).mockResolvedValue(undefined);
  });

  it('stores scoped callback token instead of raw internal API secret', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const requests: Request[] = [];
    const cloudAgentFetch = vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: { data: { cloudAgentSessionId: 'agent-session', kiloSessionId: 'ses-123' } },
        });
      }
      return Response.json({ result: { data: { executionId: 'exec-123', status: 'running' } } });
    });

    await expect(startSecurityAnalysis(createParams(false, cloudAgentFetch as never))).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    const prepareBody = await requests[0]?.json();
    const expectedCallbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'security-analysis-callback',
      resourceParts: [finding.id],
    });
    expect(prepareBody).toMatchObject({
      callbackTarget: {
        headers: { 'X-Callback-Token': expectedCallbackToken },
      },
    });
    expect(prepareBody).not.toMatchObject({
      callbackTarget: { headers: { 'X-Internal-Secret': expect.any(String) } },
    });
  });

  it('reuses existing triage and launches sandbox without retriaging', async () => {
    const previousAnalysis = {
      triage: existingTriage,
      analyzedAt: '2026-05-18T08:00:00.000Z',
      correlationId: 'previous-correlation',
    };
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      ...finding,
      analysis: previousAnalysis,
    } as never);
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { data: { cloudAgentSessionId: 'agent-session', kiloSessionId: 'ses-123' } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { data: { executionId: 'exec-123', status: 'running' } } }),
          { status: 200 }
        )
      );

    await expect(startSecurityAnalysis(createParams(true, cloudAgentFetch as never))).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    expect(triageSecurityFinding).not.toHaveBeenCalled();
    expect(setFindingPending).toHaveBeenNthCalledWith(1, {}, finding.id, previousAnalysis);
    expect(setFindingPending).toHaveBeenNthCalledWith(
      2,
      {},
      finding.id,
      expect.objectContaining({ triage: existingTriage })
    );
    expect(setFindingRunning).toHaveBeenCalledWith({}, finding.id, 'agent-session', 'ses-123');
  });

  it('falls back to full triage when sandbox-only retry has no prior triage', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      suggestedAction: 'manual_review',
    });

    await expect(startSecurityAnalysis(createParams(true, vi.fn() as never))).resolves.toEqual({
      started: true,
      triageOnly: true,
    });

    expect(triageSecurityFinding).toHaveBeenCalledTimes(1);
    expect(setFindingPending).toHaveBeenCalledWith({}, finding.id, null);
    expect(setFindingCompleted).toHaveBeenCalledTimes(1);
    expect(setFindingFailed).not.toHaveBeenCalled();
    expect(clearAnalysisStatus).not.toHaveBeenCalled();
  });
});
