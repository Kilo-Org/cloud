import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import {
  clearAnalysisStatus,
  getSecurityAgentConfigForOwner,
  getSecurityFindingById,
  setFindingPending,
  tryAcquireAnalysisStartLease,
} from './db/queries.js';
import { transitionAnalysisStartLifecycle } from './analysis-start-lifecycle.js';
import { readAnalysisCreditAdmission } from './credit-admission.js';
import {
  InsufficientCreditsError,
  buildSecurityAnalysisCallbackTarget,
  startSecurityAnalysis,
} from './launch.js';
import { generateControlToken, generateTriageToken } from './token.js';
import { triageSecurityFinding } from './triage.js';

vi.mock('./db/queries.js', () => ({
  clearAnalysisStatus: vi.fn(),
  getSecurityAgentConfigForOwner: vi.fn(),
  getSecurityFindingById: vi.fn(),
  setFindingPending: vi.fn(),
  tryAcquireAnalysisStartLease: vi.fn(),
}));
vi.mock('./analysis-start-lifecycle.js', () => ({ transitionAnalysisStartLifecycle: vi.fn() }));
vi.mock('./token.js', () => ({ generateControlToken: vi.fn(), generateTriageToken: vi.fn() }));
vi.mock('./triage.js', () => ({ triageSecurityFinding: vi.fn() }));
vi.mock('./credit-admission.js', () => ({ readAnalysisCreditAdmission: vi.fn() }));

const CALLBACK_SECRET = 'test-callback-token-secret';
const workerConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  cwe_ids: null,
  cvss_score: null,
  dependabot_html_url: null,
  first_detected_at: '2026-05-18T08:00:00.000Z',
  fixed_at: null,
  sla_due_at: null,
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

function createAutoDismissDb() {
  const updates: unknown[] = [];
  const auditRows: unknown[] = [];
  let currentFinding = finding;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ installationId: 'installation-123' }],
        }),
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => [currentFinding] }),
            }),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => ({
              returning: async () => {
                updates.push(values);
                currentFinding = { ...currentFinding, ...values };
                return [currentFinding];
              },
            }),
          }),
        }),
        insert: () => ({
          values: (values: unknown) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                auditRows.push(values);
                return [{ id: 'audit-row-1' }];
              },
            }),
          }),
        }),
      };
      return callback(tx);
    },
  };
  return { db, updates, auditRows };
}

function prepareSessionResponse(cloudAgentSessionId = 'agent-session') {
  return Response.json({
    result: { data: { cloudAgentSessionId, kiloSessionId: 'ses-123' } },
  });
}

function requestsTo(calls: unknown[][], urlPart: string): Request[] {
  return calls
    .map(call => call[0])
    .filter(
      (request): request is Request => request instanceof Request && request.url.includes(urlPart)
    );
}

function firstCallOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const [order] = mock.mock.invocationCallOrder;
  if (order === undefined) throw new Error('Expected at least one call');
  return order;
}

function createParams(retrySandboxOnly: boolean, cloudAgentFetch: typeof fetch, db: unknown = {}) {
  return {
    db: db as never,
    env: {
      ENVIRONMENT: 'development',
      KILOCODE_BACKEND_BASE_URL: 'https://backend.test',
      SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
      SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
      SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: 'https://security-analysis.test',
      CLOUD_AGENT_NEXT: { fetch: cloudAgentFetch },
      GIT_TOKEN_SERVICE: { getToken: async () => 'github-token' },
    } as unknown as CloudflareEnv,
    findingId: finding.id,
    actorUser: { id: 'user-123', api_token_pepper: null },
    githubToken: 'github-token',
    triageModel: 'triage/model',
    analysisModel: 'analysis/model',
    analysisMode: 'auto' as const,
    nextAuthSecret: 'next-auth-secret',
    internalApiSecret: 'internal-api-secret',
    callbackTokenSecret: CALLBACK_SECRET,
    retrySandboxOnly,
    lifecycleClaim: {
      source: 'manual' as const,
      findingId: finding.id,
      claimToken: 'manual-claim-token',
    },
  };
}

describe('buildSecurityAnalysisCallbackTarget', () => {
  it('keeps deployment callback routing defaults on durable Worker ingress', () => {
    expect(workerConfig.match(/"SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE": "worker"/g)).toHaveLength(
      2
    );
    expect(workerConfig).toContain('"pattern": "security-auto-analysis.kilosessions.ai"');
    expect(workerConfig).toContain('"custom_domain": true');
    expect(workerConfig).toContain(
      '"SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL": "https://security-auto-analysis.kilosessions.ai"'
    );
    expect(workerConfig).toContain(
      '"SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL": "http://localhost:8797"'
    );
  });

  it('routes callback delivery to configured Worker HTTP ingress', () => {
    expect(
      buildSecurityAnalysisCallbackTarget(
        {
          SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'worker',
          SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
          SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL: 'https://security-analysis.test/',
        },
        finding.id,
        'callback-token',
        'attempt-token'
      )
    ).toEqual({
      url: `https://security-analysis.test/internal/security-analysis-callback/${finding.id}?attempt=attempt-token`,
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
        'callback-token',
        'attempt-token'
      )
    ).toEqual({
      url: `https://app.kilo.ai/api/internal/security-analysis-callback/${finding.id}?attempt=attempt-token`,
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
        'callback-token',
        'attempt-token'
      )
    ).toThrow('SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL');
  });
});

describe('startSecurityAnalysis retrySandboxOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tryAcquireAnalysisStartLease).mockResolvedValue(true);
    vi.mocked(generateControlToken).mockResolvedValue('control-token');
    vi.mocked(generateTriageToken).mockResolvedValue('triage-token');
    vi.mocked(getSecurityAgentConfigForOwner).mockResolvedValue({
      auto_dismiss_enabled: true,
      auto_dismiss_confidence_threshold: 'high',
    } as never);
    vi.mocked(setFindingPending).mockResolvedValue(undefined);
    vi.mocked(clearAnalysisStatus).mockResolvedValue(undefined);
    vi.mocked(transitionAnalysisStartLifecycle).mockResolvedValue({ transitioned: true });
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({ outcome: 'admitted' });
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

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    const prepareBody = await requests[0]?.json();
    const expectedCallbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'security-analysis-callback',
      resourceParts: [finding.id, 'manual-claim-token'],
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

  it('passes the prepareSession organization to the modern control token', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const params = createParams(
      false,
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            result: { data: { cloudAgentSessionId: 'agent-session', kiloSessionId: 'ses-123' } },
          })
        )
        .mockResolvedValueOnce(
          Response.json({ result: { data: { executionId: 'exec-123', status: 'running' } } })
        ) as never
    );

    await expect(startSecurityAnalysis(params)).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    expect(generateControlToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-123' }),
      'next-auth-secret',
      'development',
      undefined,
      organizationId
    );
    expect(generateTriageToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-123' }),
      'next-auth-secret',
      'development',
      undefined,
      organizationId
    );
    expect(triageSecurityFinding).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
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

    await expect(
      startSecurityAnalysis(createParams(true, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    expect(triageSecurityFinding).not.toHaveBeenCalled();
    expect(setFindingPending).toHaveBeenNthCalledWith(1, {}, finding.id, previousAnalysis);
    expect(setFindingPending).toHaveBeenNthCalledWith(
      2,
      {},
      finding.id,
      expect.objectContaining({
        triage: existingTriage,
        findingDataSnapshot: expect.objectContaining({
          schemaVersion: 1,
          source: 'dependabot',
          sourceId: '42',
          repoFullName: 'kilo/repo',
          packageName: 'package-name',
        }),
      })
    );
    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        claim: expect.objectContaining({ source: 'manual', claimToken: 'manual-claim-token' }),
        outcome: {
          type: 'sandbox-running',
          cloudAgentSessionId: 'agent-session',
          kiloSessionId: 'ses-123',
        },
      })
    );
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
    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        claim: expect.objectContaining({ source: 'manual', claimToken: 'manual-claim-token' }),
        outcome: expect.objectContaining({
          type: 'triage-only-completed',
          analysis: expect.objectContaining({
            findingDataSnapshot: expect.objectContaining({
              schemaVersion: 1,
              sourceId: '42',
              packageName: 'package-name',
            }),
          }),
        }),
      })
    );
    expect(clearAnalysisStatus).not.toHaveBeenCalled();
  });

  it('launches sandbox analysis when explicitly forced by remediation', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'No relevant runtime path.',
      suggestedAction: 'manual_review',
    });
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

    await expect(
      startSecurityAnalysis({
        ...createParams(false, cloudAgentFetch as never),
        forceSandbox: true,
      })
    ).resolves.toEqual({
      started: true,
      triageOnly: false,
    });

    expect(cloudAgentFetch).toHaveBeenCalledTimes(2);
    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        claim: expect.objectContaining({ source: 'manual', claimToken: 'manual-claim-token' }),
        outcome: {
          type: 'sandbox-running',
          cloudAgentSessionId: 'agent-session',
          kiloSessionId: 'ses-123',
        },
      })
    );
  });

  it('auto-dismisses triage-only dismiss recommendations after durable Worker completion', async () => {
    const { db, updates, auditRows } = createAutoDismissDb();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'No relevant runtime path.',
      suggestedAction: 'dismiss',
    });

    await expect(startSecurityAnalysis(createParams(false, vi.fn() as never, db))).resolves.toEqual(
      {
        started: true,
        triageOnly: true,
      }
    );

    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        outcome: expect.objectContaining({ type: 'triage-only-completed' }),
      })
    );
    expect(updates[0]).toMatchObject({
      status: 'ignored',
      ignored_reason: 'not_used',
      ignored_by: 'auto-triage',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(auditRows[0]).toMatchObject({
      action: 'security.finding.auto_dismissed',
      finding_id: finding.id,
      resource_id: finding.id,
      occurred_at: expect.any(String),
      schema_version: 1,
      source_context: 'analysis_worker',
      metadata: {
        reason_code: 'not_used',
        trigger: 'auto_dismiss_policy',
        dismiss_source: 'triage',
        confidence: 'high',
        correlation_id: expect.any(String),
      },
    });
  });

  it('leaves triage-only dismiss recommendations open when auto-dismiss is disabled', async () => {
    const { db, updates, auditRows } = createAutoDismissDb();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(getSecurityAgentConfigForOwner).mockResolvedValue({
      auto_dismiss_enabled: false,
      auto_dismiss_confidence_threshold: 'high',
    } as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'No relevant runtime path.',
      suggestedAction: 'dismiss',
    });

    await expect(startSecurityAnalysis(createParams(false, vi.fn() as never, db))).resolves.toEqual(
      {
        started: true,
        triageOnly: true,
      }
    );

    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('leaves triage-only non-dismiss recommendations open after Worker completion', async () => {
    const { db, updates, auditRows } = createAutoDismissDb();
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'Maintain manual review.',
      suggestedAction: 'manual_review',
    });

    await expect(startSecurityAnalysis(createParams(false, vi.fn() as never, db))).resolves.toEqual(
      {
        started: true,
        triageOnly: true,
      }
    );

    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('returns failed starts for lifecycle settlement instead of updating findings alone', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const cloudAgentFetch = vi.fn().mockResolvedValue(
      new Response('upstream unavailable', {
        status: 503,
      })
    );

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'upstream unavailable',
      failureNeedsLifecycleTransition: true,
    });
  });

  it('returns initiate failures for lifecycle settlement after the running transition', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
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
      .mockResolvedValueOnce(new Response('initiate unavailable', { status: 503 }));

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'initiate unavailable',
      failureNeedsLifecycleTransition: true,
    });

    expect(transitionAnalysisStartLifecycle).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ outcome: expect.objectContaining({ type: 'sandbox-running' }) })
    );
  });

  it('applies the credit admission before triage and session preparation', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({
      outcome: 'insufficient_credits',
      message: 'Insufficient credits: $1 minimum required',
    });
    const cloudAgentFetch = vi.fn();

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(triageSecurityFinding).not.toHaveBeenCalled();
    expect(setFindingPending).not.toHaveBeenCalled();
    expect(cloudAgentFetch).not.toHaveBeenCalled();
  });

  it('reads admission with the organization id of an organization-owned finding', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({
      outcome: 'insufficient_credits',
      message: 'Insufficient credits',
    });

    await expect(
      startSecurityAnalysis(createParams(false, vi.fn() as never))
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(readAnalysisCreditAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: 'control-token',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
    );
  });

  it('reads admission without an organization id for a personally owned finding', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      ...finding,
      owned_by_organization_id: null,
      owned_by_user_id: 'user-123',
    } as never);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({
      outcome: 'insufficient_credits',
      message: 'Insufficient credits',
    });

    await expect(
      startSecurityAnalysis(createParams(false, vi.fn() as never))
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(readAnalysisCreditAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: undefined })
    );
  });

  it('treats an unavailable admission read as a retryable failure without paid work', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({
      outcome: 'unavailable',
      message: 'Cloud Agent credit admission returned HTTP 503',
    });
    const cloudAgentFetch = vi.fn();

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'Cloud Agent credit admission returned HTTP 503',
      failureNeedsLifecycleTransition: true,
    });

    expect(triageSecurityFinding).not.toHaveBeenCalled();
    expect(setFindingPending).not.toHaveBeenCalled();
    expect(cloudAgentFetch).not.toHaveBeenCalled();
  });

  it('declares a refused admission as a permanent failure without paid work', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({
      outcome: 'refused',
      message: 'Cloud Agent credit admission was refused',
    });
    const cloudAgentFetch = vi.fn();

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'Cloud Agent credit admission was refused',
      failureNeedsLifecycleTransition: true,
      failureCode: 'PERMISSION_DENIED_PERMANENT',
    });

    expect(triageSecurityFinding).not.toHaveBeenCalled();
    expect(requestsTo(cloudAgentFetch.mock.calls, '/trpc/prepareSession')).toHaveLength(0);
    expect(
      requestsTo(cloudAgentFetch.mock.calls, '/trpc/initiateFromKilocodeSessionV2')
    ).toHaveLength(0);
  });

  it('releases the prepared session when the start reports insufficient credits', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse())
      .mockResolvedValueOnce(new Response('insufficient credits', { status: 402 }))
      .mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const interrupts = requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession');
    expect(interrupts).toHaveLength(1);
    const interrupt = interrupts[0];
    if (!(interrupt instanceof Request)) throw new Error('Expected interrupt request');
    await expect(interrupt.json()).resolves.toEqual({ sessionId: 'agent-session' });
  });

  it('releases the prepared session when the start fails after the running transition', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse('agent-session-503'))
      .mockResolvedValueOnce(new Response('initiate unavailable', { status: 503 }))
      .mockResolvedValue(new Response('interrupt unavailable', { status: 500 }));

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'initiate unavailable',
      failureNeedsLifecycleTransition: true,
    });

    const interrupts = requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession');
    expect(interrupts).toHaveLength(1);
    const interrupt = interrupts[0];
    if (!(interrupt instanceof Request)) throw new Error('Expected interrupt request');
    await expect(interrupt.json()).resolves.toEqual({ sessionId: 'agent-session-503' });
  });

  it('keeps the initiate failure outcome when the interrupt itself fails', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse())
      .mockResolvedValueOnce(new Response('initiate unavailable', { status: 503 }))
      .mockRejectedValue(new Error('interrupt unavailable'));

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({
      started: false,
      error: 'initiate unavailable',
      failureNeedsLifecycleTransition: true,
    });

    expect(requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession')).toHaveLength(1);
  });

  it('does not interrupt the prepared session when the start succeeds', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse())
      .mockResolvedValueOnce(
        Response.json({ result: { data: { executionId: 'exec-123', status: 'running' } } })
      );

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({ started: true, triageOnly: false });

    expect(requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession')).toHaveLength(0);
    expect(cloudAgentFetch).toHaveBeenCalledTimes(2);
  });

  it('does not prepare or interrupt a session for a triage-only result', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({ ...finding, analysis: null } as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue({
      ...existingTriage,
      needsSandboxAnalysis: false,
      needsSandboxReasoning: 'Maintain manual review.',
      suggestedAction: 'manual_review',
    });
    const cloudAgentFetch = vi.fn();

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({ started: true, triageOnly: true });

    expect(requestsTo(cloudAgentFetch.mock.calls, '/trpc/prepareSession')).toHaveLength(0);
    expect(
      requestsTo(cloudAgentFetch.mock.calls, '/trpc/initiateFromKilocodeSessionV2')
    ).toHaveLength(0);
    expect(requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession')).toHaveLength(0);
  });

  it("releases only this attempt's prepared session when the claim was superseded", async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({ outcome: 'admitted' });
    vi.mocked(transitionAnalysisStartLifecycle).mockResolvedValueOnce({ transitioned: false });
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse('agent-session-superseded'))
      .mockResolvedValue(new Response('', { status: 200 }));

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({ started: false, error: 'Finding was superseded during analysis' });

    expect(clearAnalysisStatus).toHaveBeenCalledWith({}, finding.id);
    // The interrupt must carry the prepared id from this attempt, never an id
    // read from the finding row, because a newer attempt may already own that row.
    const interrupts = requestsTo(cloudAgentFetch.mock.calls, '/trpc/interruptSession');
    expect(interrupts).toHaveLength(1);
    const interrupt = interrupts[0];
    if (!(interrupt instanceof Request)) throw new Error('Expected interrupt request');
    await expect(interrupt.json()).resolves.toEqual({ sessionId: 'agent-session-superseded' });
    expect(
      requestsTo(cloudAgentFetch.mock.calls, '/trpc/initiateFromKilocodeSessionV2')
    ).toHaveLength(0);
  });

  it('reads admission before the triage call and before session preparation', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding as never);
    vi.mocked(triageSecurityFinding).mockResolvedValue(existingTriage);
    vi.mocked(readAnalysisCreditAdmission).mockResolvedValue({ outcome: 'admitted' });
    vi.mocked(transitionAnalysisStartLifecycle).mockResolvedValue({ transitioned: true });
    const cloudAgentFetch = vi
      .fn()
      .mockResolvedValueOnce(prepareSessionResponse())
      .mockResolvedValueOnce(
        Response.json({ result: { data: { executionId: 'exec-123', status: 'running' } } })
      );

    await expect(
      startSecurityAnalysis(createParams(false, cloudAgentFetch as never))
    ).resolves.toEqual({ started: true, triageOnly: false });

    expect(firstCallOrder(vi.mocked(generateControlToken))).toBeLessThan(
      firstCallOrder(vi.mocked(readAnalysisCreditAdmission))
    );
    expect(firstCallOrder(vi.mocked(readAnalysisCreditAdmission))).toBeLessThan(
      firstCallOrder(vi.mocked(triageSecurityFinding))
    );
    expect(firstCallOrder(vi.mocked(triageSecurityFinding))).toBeLessThan(
      firstCallOrder(cloudAgentFetch)
    );
  });
});
