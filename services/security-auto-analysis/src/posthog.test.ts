import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackSecurityAnalysisCompleted } from './posthog.js';

describe('trackSecurityAnalysisCompleted', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits the Worker completion analytics event with legacy event semantics', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await trackSecurityAnalysisCompleted({
      env: { NEXT_PUBLIC_POSTHOG_KEY: 'phc_test' },
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      finding: {
        owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        analysis_started_at: '2026-05-18T10:00:00.000Z',
      } as never,
      analysis: {
        analyzedAt: '2026-05-18T10:05:00.000Z',
        modelUsed: 'analysis/model',
        triageModel: 'triage/model',
        analysisModel: 'analysis/model',
        triggeredByUserId: 'user-123',
        triage: {
          needsSandboxAnalysis: true,
          needsSandboxReasoning: 'Reachability unknown',
          suggestedAction: 'analyze_codebase',
          confidence: 'medium',
          triageAt: '2026-05-18T10:01:00.000Z',
        },
        sandboxAnalysis: {
          isExploitable: false,
          exploitabilityReasoning: 'No usage',
          usageLocations: [],
          suggestedFix: 'Upgrade',
          suggestedAction: 'dismiss',
          summary: 'Safe',
          rawMarkdown: '# Safe',
          analysisAt: '2026-05-18T10:05:00.000Z',
        },
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      api_key: 'phc_test',
      distinct_id: 'user-123',
      event: 'security_agent_analysis_completed',
      properties: {
        userId: 'user-123',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        model: 'analysis/model',
        triageModel: 'triage/model',
        analysisModel: 'analysis/model',
        triageOnly: false,
        isExploitable: false,
        feature: 'security-agent',
        operation: 'analysis_completed',
      },
    });
  });
});
