import { describe, expect, it } from 'vitest';
import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingDecisionResponseSchema,
  MirrorPayloadSchema,
  UpdateClassifierModelRequestSchema,
} from './index';

describe('auto routing contracts', () => {
  it('validates the cross-service request and response contracts', () => {
    expect(
      MirrorPayloadSchema.parse({
        path: '/chat/completions',
        receivedAt: '2026-06-10T12:00:00.000Z',
        sessionId: 'session-123',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"auto","messages":[]}',
      })
    ).toMatchObject({ sessionId: 'session-123' });

    expect(() =>
      MirrorPayloadSchema.parse({
        path: '/chat/completions',
        receivedAt: 'not-a-timestamp',
        sessionId: 'session-123',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"auto","messages":[]}',
      })
    ).toThrow();

    expect(
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: null,
        classifierResult: null,
      })
    ).toEqual({ cost: 0, decision: null, classifierResult: null });

    expect(
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: null,
        classifierResult: {
          classification: {
            taskType: 'implementation',
            subtaskType: 'feature_development',
            contextComplexity: 'small',
            reasoningComplexity: 'low',
            riskLevel: 'low',
            executionMode: 'code_change',
            requiresTools: true,
            confidence: 0.8,
          },
          normalized: {
            apiKind: 'chat_completions',
            requestedModel: 'anthropic/claude-sonnet-4',
            systemPromptPrefix: 'You are Kilo Code.',
            userPromptPrefix: 'Add parser tests.',
            latestUserPromptPrefix: 'Focus on latency instead.',
            messageCount: 4,
            hasTools: true,
            stream: true,
            providerHints: { provider: null, providerOptions: null },
          },
        },
      })
    ).toMatchObject({
      classifierResult: {
        normalized: {
          latestUserPromptPrefix: 'Focus on latency instead.',
        },
      },
    });

    expect(
      AutoRoutingClassifierModelResponseSchema.parse({
        model: 'google/gemini-2.5-flash-lite',
        defaultModel: 'google/gemini-2.5-flash-lite',
      })
    ).toMatchObject({ model: 'google/gemini-2.5-flash-lite' });

    expect(
      UpdateClassifierModelRequestSchema.parse({ model: ' google/gemini-2.5-flash-lite ' })
    ).toEqual({
      model: 'google/gemini-2.5-flash-lite',
    });

    expect(
      AutoRoutingClassifierAnalyticsResponseSchema.parse({
        period: '24h',
        summary: {
          totalRequests: 0,
          classifiedRequests: 0,
          cachedRequests: 0,
          classifierErrors: 0,
          invalidRequests: 0,
          totalCostCredits: 0,
          avgDurationMs: 0,
          p95DurationMs: 0,
          avgConfidence: 0,
          withSessionId: 0,
          uniqueSessions: 0,
          requiresTools: 0,
          mirroredHasTools: 0,
          avgBodyBytes: 0,
        },
        statusBreakdown: [],
        taskTypeBreakdown: [],
        taskSubtypeBreakdown: [],
        classifierModelBreakdown: [],
      })
    ).toMatchObject({ period: '24h' });
  });
});
