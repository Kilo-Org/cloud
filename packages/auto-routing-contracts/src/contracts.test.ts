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
    const normalizedInput = {
      apiKind: 'chat_completions',
      requestedModel: 'kilo-auto/free',
      systemPromptPrefix: 'You are Kilo Code.',
      userPromptPrefix: 'Add parser tests.',
      latestUserPromptPrefix: null,
      messageCount: 2,
      hasTools: false,
      stream: true,
      providerHints: { provider: null, providerOptions: null },
    };

    const mirrorPayload = {
      input: normalizedInput,
      userId: 'user-1',
      sessionId: 'session-123',
      machineId: 'machine-1',
      clientRequestId: 'req-1',
      mode: 'code',
      userAgent: 'Kilo-Code/4.106.0',
      bodyBytes: 1234,
    };

    expect(MirrorPayloadSchema.parse(mirrorPayload)).toMatchObject({
      sessionId: 'session-123',
      userId: 'user-1',
    });

    // One broken constraint per case: identity fields are null-or-nonempty,
    // never empty strings.
    expect(() => MirrorPayloadSchema.parse({ ...mirrorPayload, userId: '' })).toThrow();
    expect(() => MirrorPayloadSchema.parse({ ...mirrorPayload, sessionId: '' })).toThrow();
    expect(() => MirrorPayloadSchema.parse({ ...mirrorPayload, mode: '   ' })).toThrow();
    expect(() => MirrorPayloadSchema.parse({ ...mirrorPayload, bodyBytes: -1 })).toThrow();
    expect(() =>
      MirrorPayloadSchema.parse({ ...mirrorPayload, input: { apiKind: 'chat_completions' } })
    ).toThrow();

    expect(
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: null,
        classifierResult: null,
      })
    ).toEqual({ cost: 0, decision: null, classifierResult: null });

    // Routing context is optional (deploys never coordinate) and validated
    // when present.
    const routing = {
      autoModel: 'kilo-auto/frontier',
      candidateModels: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5'],
      resolvedModel: 'anthropic/claude-opus-4.8',
    };
    expect(MirrorPayloadSchema.parse({ ...mirrorPayload, routing })).toMatchObject({ routing });
    expect(MirrorPayloadSchema.parse({ ...mirrorPayload, routing: null })).toMatchObject({
      routing: null,
    });
    expect(() =>
      MirrorPayloadSchema.parse({ ...mirrorPayload, routing: { autoModel: '' } })
    ).toThrow();
    expect(() =>
      MirrorPayloadSchema.parse({
        ...mirrorPayload,
        routing: { ...routing, candidateModels: [''] },
      })
    ).toThrow();

    const routerDecision = {
      source: 'morph_router',
      model: 'anthropic/claude-sonnet-4.6',
      routerModel: 'claude-sonnet-4-6',
      difficulty: 'easy',
      confidence: 0.97,
      ambiguity: 'low',
      domain: 'coding',
    };
    expect(
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: routerDecision,
        classifierResult: null,
      })
    ).toMatchObject({ decision: { model: 'anthropic/claude-sonnet-4.6' } });
    expect(
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: { ...routerDecision, difficulty: null, confidence: null },
        classifierResult: null,
      })
    ).toMatchObject({ decision: { difficulty: null } });
    expect(() =>
      AutoRoutingDecisionResponseSchema.parse({
        cost: 0,
        decision: { ...routerDecision, source: 'other_router' },
        classifierResult: null,
      })
    ).toThrow();

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
          fallbackRequests: 0,
          classifierErrors: 0,
          invalidRequests: 0,
          totalCostCredits: 0,
          avgDurationMs: 0,
          p95DurationMs: 0,
        },
        statusBreakdown: [],
        taskTypeBreakdown: [],
        taskSubtypeBreakdown: [],
        classifierModelBreakdown: [],
      })
    ).toMatchObject({ period: '24h' });
  });
});
