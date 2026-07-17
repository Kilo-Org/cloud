import { describe, expect, it } from 'vitest';
import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingDecisionResponseSchema,
  MirrorPayloadSchema,
  RoutingConstraintsSchema,
  UpdateClassifierModelRequestSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
} from './index';
import type { RoutingConstraints } from './index';
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
        decision: {
          model: 'minimax/minimax-m3',
          taskType: null,
          subtaskType: null,
          source: 'coding_plan_default',
          tableVersion: 'coding-plan:v1',
          reasoningEffort: null,
          sticky: false,
        },
        classifierResult: null,
      })
    ).toMatchObject({
      decision: {
        model: 'minimax/minimax-m3',
        taskType: null,
        subtaskType: null,
        source: 'coding_plan_default',
      },
    });

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
  it('applies config defaults for repetitions, classifier latency, switch threshold, and auto decider cost bounds', () => {
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
    expect(result.bestAccuracySwitchThreshold).toBe(0.05);
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

describe('RoutingConstraintsSchema', () => {
  it('accepts a fully populated constraints object', () => {
    const result = RoutingConstraintsSchema.parse({
      requiredInputModalities: ['image', 'file'],
      promptTokensEstimate: 12345,
    });
    expect(result).toEqual({
      requiredInputModalities: ['image', 'file'],
      promptTokensEstimate: 12345,
    });
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(RoutingConstraintsSchema.parse({})).toEqual({});
  });

  it('rejects non-positive promptTokensEstimate', () => {
    expect(() => RoutingConstraintsSchema.parse({ promptTokensEstimate: 0 })).toThrow();
    expect(() => RoutingConstraintsSchema.parse({ promptTokensEstimate: -1 })).toThrow();
    expect(() => RoutingConstraintsSchema.parse({ promptTokensEstimate: 1.5 })).toThrow();
  });

  it('rejects empty/whitespace modality strings', () => {
    expect(() =>
      RoutingConstraintsSchema.parse({ requiredInputModalities: ['image', ''] })
    ).toThrow();
    expect(() =>
      RoutingConstraintsSchema.parse({ requiredInputModalities: ['image', '   '] })
    ).toThrow();
  });
});

describe('MirrorPayloadSchema with routing constraints', () => {
  const baseNormalized = {
    apiKind: 'chat_completions' as const,
    requestedModel: 'kilo-auto/free',
    systemPromptPrefix: 'You are Kilo Code.',
    userPromptPrefix: 'Add parser tests.',
    latestUserPromptPrefix: null,
    messageCount: 2,
    hasTools: false,
    stream: true,
    providerHints: { provider: null, providerOptions: null },
  };

  const basePayload = {
    input: baseNormalized,
    userId: 'user-1',
    sessionId: 'session-123',
    machineId: 'machine-1',
    clientRequestId: 'req-1',
    mode: 'code',
    userAgent: 'Kilo-Code/4.106.0',
    bodyBytes: 1234,
  };

  it('parses successfully without constraints (no behavior change)', () => {
    const parsed = MirrorPayloadSchema.parse(basePayload);
    expect(parsed.constraints).toBeUndefined();
  });

  it('parses successfully with constraints present', () => {
    const parsed = MirrorPayloadSchema.parse({
      ...basePayload,
      constraints: {
        requiredInputModalities: ['image'],
        promptTokensEstimate: 8000,
      },
    });
    expect(parsed.constraints).toEqual({
      requiredInputModalities: ['image'],
      promptTokensEstimate: 8000,
    });
  });

  it('strips unknown keys for backward compatibility with older workers', () => {
    const parsed = MirrorPayloadSchema.parse({
      ...basePayload,
      futureFlag: true,
      nestedFuture: { a: 1 },
    });
    expect((parsed as Record<string, unknown>).futureFlag).toBeUndefined();
    expect((parsed as Record<string, unknown>).nestedFuture).toBeUndefined();
  });

  it('accepts a payload whose promptTokensEstimate equals the estimator output', () => {
    // Realistic multi-message body mixing text, a remote image URL, and a
    // large base64 image — the estimator must exclude both image payloads
    // and produce a positive integer that satisfies the schema.
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are Kilo Code.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What do you see in this image?' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/' + 'x'.repeat(500) + '.png' },
            },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,' + 'A'.repeat(20_000) },
            },
          ],
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/a.ts' }) },
            },
          ],
        },
        {
          role: 'tool',
          content: JSON.stringify({ result: 'file contents ' + 'y'.repeat(800) }),
        },
      ],
      max_tokens: 2000,
    };

    const estimate = estimateRoutingTokens(body);
    expect(Number.isInteger(estimate)).toBe(true);
    expect(estimate).toBeGreaterThanOrEqual(1);

    // The mirror payload's constraints must accept this estimate verbatim.
    const constraints: RoutingConstraints = {
      requiredInputModalities: detectRequiredInputModalities(body),
      promptTokensEstimate: estimate,
    };

    const parsed = MirrorPayloadSchema.parse({
      ...basePayload,
      constraints,
    });

    expect(parsed.constraints?.promptTokensEstimate).toBe(estimate);
    expect(parsed.constraints?.requiredInputModalities).toEqual(['image']);
  });
});

describe('package root re-exports', () => {
  // These imports come from the package entry point (./index) — proves
  // S2 (gateway) and S3 (worker) can import them from the package root
  // without reaching into deep paths.
  it('re-exports detectRequiredInputModalities from the package root', () => {
    expect(typeof detectRequiredInputModalities).toBe('function');
  });

  it('re-exports estimateRoutingTokens from the package root', () => {
    expect(typeof estimateRoutingTokens).toBe('function');
  });

  it('re-exports RoutingConstraintsSchema from the package root', () => {
    expect(RoutingConstraintsSchema.safeParse({}).success).toBe(true);
  });
});
