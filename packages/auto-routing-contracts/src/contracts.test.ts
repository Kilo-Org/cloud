import { describe, expect, it } from 'vitest';
import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingDecisionResponseSchema,
  MirrorPayloadSchema,
  UpdateClassifierModelRequestSchema,
} from './index';
import {
  BenchmarkConfigSchema,
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
  resolveBenchmarkIdentity,
} from './benchmark';

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
    expect(
      MirrorPayloadSchema.parse({
        ...mirrorPayload,
        routingPolicy: { deniedModelIds: ['openai/gpt-4o'] },
      })
    ).toMatchObject({
      routingPolicy: { deniedModelIds: ['openai/gpt-4o'] },
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
        override: null,
        benchmarkWinner: 'google/gemini-2.5-flash-lite',
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

describe('BenchmarkConfigSchema defaults', () => {
  it('applies config defaults for repetitions, classifier latency, and auto decider cost bounds', () => {
    const result = BenchmarkConfigSchema.parse({
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      minAccuracy: 0.8,
      maxConcurrency: 4,
      benchmarkUserId: null,
      benchmarkOrgId: null,
      switchCostFactor: 2,
      updatedAt: null,
      updatedBy: null,
      // classifierRepetitions, deciderRepetitions, classifierMaxP95LatencyMs intentionally omitted
    });
    expect(result.classifierRepetitions).toBe(1);
    expect(result.deciderRepetitions).toBe(1);
    expect(result.classifierMaxP95LatencyMs).toBe(1000);
    expect(result.autoDeciderMinCostUsd).toBe(15);
    expect(result.autoDeciderMaxCostUsd).toBe(25);
  });

  it('accepts the benchmark maximum concurrency cap of 100', () => {
    const result = BenchmarkConfigSchema.safeParse({
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      minAccuracy: 0.8,
      maxConcurrency: 100,
      benchmarkUserId: null,
      benchmarkOrgId: null,
      switchCostFactor: 2,
      updatedAt: null,
      updatedBy: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts explicit manual and excluded auto decider model lists', () => {
    const result = BenchmarkConfigSchema.parse({
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      manualDeciderModels: [{ id: 'model/c', reasoningEffort: 'high' }],
      autoDeciderModels: [{ id: 'model/b', reasoningEffort: null, avgAttemptCostUsd: 21.1 }],
      excludedAutoDeciderModels: ['model/d'],
      minAccuracy: 0.7,
      switchCostFactor: 3,
      maxConcurrency: 10,
      benchmarkUserId: null,
      benchmarkOrgId: null,
      updatedAt: null,
      updatedBy: null,
    });

    expect(result.manualDeciderModels).toEqual([{ id: 'model/c', reasoningEffort: 'high' }]);
    expect(result.autoDeciderModels).toEqual([
      { id: 'model/b', reasoningEffort: null, avgAttemptCostUsd: 21.1 },
    ]);
    expect(result.excludedAutoDeciderModels).toEqual(['model/d']);
  });

  it('rejects auto decider cost bounds where min is greater than max', () => {
    const result = BenchmarkConfigSchema.safeParse({
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      minAccuracy: 0.7,
      switchCostFactor: 3,
      maxConcurrency: 10,
      benchmarkUserId: null,
      benchmarkOrgId: null,
      autoDeciderMinCostUsd: 30,
      autoDeciderMaxCostUsd: 20,
      updatedAt: null,
      updatedBy: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path[0] === 'autoDeciderMaxCostUsd')).toBe(
        true
      );
    }
  });
});

describe('resolveBenchmarkIdentity', () => {
  it('uses worker defaults when benchmark identity overrides are null', () => {
    expect(resolveBenchmarkIdentity({ benchmarkUserId: null, benchmarkOrgId: null })).toEqual({
      benchmarkUserId: DEFAULT_BENCHMARK_USER_ID,
      benchmarkOrgId: DEFAULT_BENCHMARK_ORG_ID,
    });
  });

  it('preserves configured benchmark identity overrides', () => {
    expect(
      resolveBenchmarkIdentity({
        benchmarkUserId: 'override-user',
        benchmarkOrgId: 'override-org',
      })
    ).toEqual({
      benchmarkUserId: 'override-user',
      benchmarkOrgId: 'override-org',
    });
  });
});

describe('BenchmarkConfigSchema duplicate model ids', () => {
  const base = {
    minAccuracy: 0.8,
    maxConcurrency: 4,
    benchmarkUserId: null,
    benchmarkOrgId: null,
    switchCostFactor: 2,
    updatedAt: null,
    updatedBy: null,
  };

  it('rejects duplicate classifier model ids with a field-specific issue', () => {
    const result = BenchmarkConfigSchema.safeParse({
      ...base,
      classifierModels: ['model/a', 'model/a'],
      deciderModels: [{ id: 'model/b' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.path[0] === 'classifierModels');
      expect(issue?.path).toEqual(['classifierModels', 1]);
      expect(issue?.message).toContain('Duplicate model id');
    }
  });

  it('rejects duplicate decider model ids (trim-normalized)', () => {
    const result = BenchmarkConfigSchema.safeParse({
      ...base,
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }, { id: '  model/b  ' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.path[0] === 'deciderModels');
      expect(issue?.path).toEqual(['deciderModels', 1]);
    }
  });

  it('accepts distinct model ids', () => {
    const result = BenchmarkConfigSchema.safeParse({
      ...base,
      classifierModels: ['model/a', 'model/b'],
      deciderModels: [{ id: 'model/c' }, { id: 'model/d' }],
    });
    expect(result.success).toBe(true);
  });
});
