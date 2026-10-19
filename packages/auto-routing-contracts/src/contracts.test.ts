import { describe, expect, it } from 'vitest';
import {
  AutoRoutingClassifierAnalyticsResponseSchema,
  AutoRoutingClassifierModelResponseSchema,
  AutoRoutingDecisionResponseSchema,
  AutoRoutingDecisionSchema,
  AutoRoutingSettingsResponseSchema,
  MirrorPayloadSchema,
  RoutingConstraintsSchema,
  UpdateAutoRoutingSettingsRequestSchema,
  UpdateClassifierModelRequestSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
} from './index';
import type { RoutingConstraints } from './index';
import {
  BenchmarkConfigSchema,
  BenchmarkDeciderModelSchema,
  BenchmarkModelSummarySchema,
  BenchmarkProfileStatusesRequestSchema,
  CustomRoutingTableRequestSchema,
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
  RegisterBenchmarkProfilesRequestSchema,
  SyncBenchmarkSubscriptionsRequestSchema,
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
  it.each([
    ['efficient', '~deepseek/deepseek-flash-latest'],
    ['frontier', '~openai/gpt-sol-latest'],
  ] as const)('uses the %s preset only when the pool is omitted', (router, alias) => {
    const input = {
      router,
      classifierModels: ['classifier/model'],
      minAccuracy: 0.7,
      benchmarkUserId: null,
      switchCostFactor: 3,
      updatedAt: null,
      updatedBy: null,
    };
    expect(BenchmarkConfigSchema.parse(input).deciderModels).toEqual([{ id: alias }]);
    expect(
      BenchmarkConfigSchema.parse({
        ...input,
        deciderModels: [{ id: 'vendor/explicit-selection' }],
      }).deciderModels
    ).toEqual([{ id: 'vendor/explicit-selection' }]);
    expect(BenchmarkConfigSchema.safeParse({ ...input, deciderModels: [] }).success).toBe(false);
  });

  it('applies config defaults for repetitions, classifier latency, and switch threshold', () => {
    const result = BenchmarkConfigSchema.parse({
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      minAccuracy: 0.8,
      benchmarkUserId: null,
      benchmarkOrgId: null,
      switchCostFactor: 2,
      updatedAt: null,
      updatedBy: null,
    });
    expect(result.classifierRepetitions).toBe(1);
    expect(result.deciderRepetitions).toBe(1);
    expect(result.classifierMaxP95LatencyMs).toBe(1000);
    expect(result.bestAccuracySwitchThreshold).toBe(0.05);
    expect(result.productionTokenProfile).toBeNull();
    expect(result.switchHorizonTurns).toBeNull();
    expect(result.lowConfidenceThreshold).toBeNull();
  });

  it('accepts only null or probability-range confidence thresholds', () => {
    const config = {
      classifierModels: ['model/a'],
      deciderModels: [{ id: 'model/b' }],
      minAccuracy: 0.8,
      benchmarkUserId: null,
      switchCostFactor: 2,
      updatedAt: null,
      updatedBy: null,
    };
    for (const lowConfidenceThreshold of [null, 0, 0.8, 1]) {
      expect(
        BenchmarkConfigSchema.parse({ ...config, lowConfidenceThreshold }).lowConfidenceThreshold
      ).toBe(lowConfidenceThreshold);
    }
    for (const lowConfidenceThreshold of [-0.1, 1.1]) {
      expect(BenchmarkConfigSchema.safeParse({ ...config, lowConfidenceThreshold }).success).toBe(
        false
      );
    }
  });

  it.each(['efficient', 'frontier'])(
    'strips retired auto decider fields for %s clients',
    router => {
      const result = BenchmarkConfigSchema.parse({
        router,
        classifierModels: ['model/a'],
        deciderModels: [{ id: 'model/b', variant: 'retired', reasoningEffort: 'high' }],
        manualDeciderModels: [{ id: 'model/c', reasoningEffort: 'high' }],
        autoDeciderModels: [{ id: 'model/b', reasoningEffort: null, avgAttemptCostUsd: 21.1 }],
        excludedAutoDeciderModels: ['model/d'],
        autoDeciderMinCostUsd: 30,
        autoDeciderMaxCostUsd: 20,
        minAccuracy: 0.7,
        switchCostFactor: 3,
        benchmarkUserId: null,
        benchmarkOrgId: null,
        updatedAt: null,
        updatedBy: null,
      });

      expect(result.deciderModels).toEqual([{ id: 'model/b' }]);
      for (const field of [
        'manualDeciderModels',
        'autoDeciderModels',
        'excludedAutoDeciderModels',
        'autoDeciderMinCostUsd',
        'autoDeciderMaxCostUsd',
      ]) {
        expect(result).not.toHaveProperty(field);
      }
    }
  );

  it.each(['efficient', 'frontier'])(
    'strips the retired concurrency knobs from %s payloads',
    router => {
      const result = BenchmarkConfigSchema.parse({
        router,
        classifierModels: ['model/a'],
        deciderModels: [{ id: 'model/b' }],
        minAccuracy: 0.7,
        switchCostFactor: 3,
        maxConcurrency: 100,
        userMaxConcurrency: 100,
        benchmarkUserId: null,
        benchmarkOrgId: null,
        updatedAt: null,
        updatedBy: null,
      });

      expect(result).not.toHaveProperty('maxConcurrency');
      expect(result).not.toHaveProperty('userMaxConcurrency');
    }
  );
});

describe('resolveBenchmarkIdentity', () => {
  it('uses worker defaults when benchmark identity overrides are null', () => {
    expect(resolveBenchmarkIdentity({ benchmarkUserId: null, benchmarkOrgId: null })).toEqual({
      benchmarkUserId: DEFAULT_BENCHMARK_USER_ID,
      benchmarkOrgId: DEFAULT_BENCHMARK_ORG_ID,
    });
  });

  it('preserves configured internal bot identity overrides', () => {
    expect(
      resolveBenchmarkIdentity({
        benchmarkUserId: 'bot-internal-override',
        benchmarkOrgId: 'override-org',
      })
    ).toEqual({
      benchmarkUserId: 'bot-internal-override',
      benchmarkOrgId: 'override-org',
    });
  });

  it.each(['override-user', 'bot-code-review-org-1', 'xbot-internal-x'])(
    'rejects a %s override instead of falling back to the default user',
    benchmarkUserId => {
      expect(() => resolveBenchmarkIdentity({ benchmarkUserId, benchmarkOrgId: null })).toThrow(
        /is not an internal bot user/
      );
    }
  );
});

describe('BenchmarkConfigSchema duplicate model ids', () => {
  const base = {
    minAccuracy: 0.8,
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

describe('BenchmarkModelSummarySchema variant field', () => {
  const baseSummary = {
    model: 'provider/model',
    routeKey: '*' as const,
    accuracy: 0.9,
    avgCostUsd: 0.001,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    cases: 10,
    errors: 0,
  };

  it('parses legacy summaries without variant', () => {
    const parsed = BenchmarkModelSummarySchema.parse(baseSummary);
    expect(parsed.variant).toBeUndefined();
  });

  it('parses optional nullable variant', () => {
    expect(BenchmarkModelSummarySchema.parse({ ...baseSummary, variant: 'xhigh' }).variant).toBe(
      'xhigh'
    );
    expect(BenchmarkModelSummarySchema.parse({ ...baseSummary, variant: null }).variant).toBeNull();
  });
});

describe('BenchmarkDeciderModelSchema variant compatibility', () => {
  it('parses legacy effort-only models', () => {
    const parsed = BenchmarkDeciderModelSchema.parse({ id: 'm', reasoningEffort: 'high' });
    expect(parsed).toMatchObject({ id: 'm', reasoningEffort: 'high' });
    expect(parsed.variant).toBeUndefined();
  });

  it('parses variant-only models', () => {
    const parsed = BenchmarkDeciderModelSchema.parse({ id: 'm', variant: 'xhigh' });
    expect(parsed).toMatchObject({ id: 'm', variant: 'xhigh', reasoningEffort: null });
  });

  it('rejects both non-null variant and reasoningEffort', () => {
    expect(
      BenchmarkDeciderModelSchema.safeParse({
        id: 'm',
        variant: 'xhigh',
        reasoningEffort: 'high',
      }).success
    ).toBe(false);
  });

  it('allows both null/absent (default effort null)', () => {
    expect(BenchmarkDeciderModelSchema.parse({ id: 'm' })).toMatchObject({
      id: 'm',
      reasoningEffort: null,
    });
  });
});

describe('AutoRoutingDecisionSchema variant compatibility', () => {
  const baseBenchmark = {
    model: 'provider/model',
    taskType: 'implementation' as const,
    subtaskType: 'feature_development' as const,
    source: 'benchmark' as const,
    tableVersion: 'v1',
    sticky: false,
  };

  it('parses a legacy decision with reasoningEffort only', () => {
    const parsed = AutoRoutingDecisionSchema.parse({
      ...baseBenchmark,
      reasoningEffort: 'high',
    });
    expect(parsed).toMatchObject({ reasoningEffort: 'high' });
    expect('variant' in parsed ? parsed.variant : undefined).toBeUndefined();
  });

  it('parses a decision with variant only', () => {
    const parsed = AutoRoutingDecisionSchema.parse({
      ...baseBenchmark,
      variant: 'xhigh',
    });
    expect(parsed).toMatchObject({ variant: 'xhigh' });
  });

  it('rejects a decision with both non-null variant and reasoningEffort', () => {
    expect(
      AutoRoutingDecisionSchema.safeParse({
        ...baseBenchmark,
        variant: 'xhigh',
        reasoningEffort: 'high',
      }).success
    ).toBe(false);
  });

  it('allows null classification and table fields only on a fallback decision', () => {
    const unclassified = {
      ...baseBenchmark,
      taskType: null,
      subtaskType: null,
      tableVersion: null,
    };
    expect(AutoRoutingDecisionSchema.safeParse({ ...unclassified, fallback: true }).success).toBe(
      true
    );
    expect(AutoRoutingDecisionSchema.safeParse(unclassified).success).toBe(false);
    expect(AutoRoutingDecisionSchema.safeParse({ ...unclassified, fallback: false }).success).toBe(
      false
    );
  });
});

describe('owner pool settings wire contracts', () => {
  it('accepts null pool (inherit) on update', () => {
    const parsed = UpdateAutoRoutingSettingsRequestSchema.parse({
      ownerType: 'user',
      ownerId: 'user-1',
      mode: null,
      pool: null,
    });
    expect(parsed.pool).toBeNull();
  });

  it('accepts a configured pool on settings response with statuses', () => {
    const parsed = AutoRoutingSettingsResponseSchema.parse({
      ownerType: 'org',
      ownerId: 'org-1',
      mode: 'cost_per_accuracy',
      configuredMode: null,
      defaultMode: 'cost_per_accuracy',
      configuredPool: [{ model: 'a/b' }],
      poolStatuses: [{ entry: { model: 'a/b', variant: null }, status: 'pending' }],
    });
    expect(parsed.poolStatuses).toHaveLength(1);
  });

  it('accepts optional retryEntries that are a subset of pool by poolEntryKey', () => {
    const pool = [{ model: 'a/b' }, { model: 'c/d' }];
    const parsed = UpdateAutoRoutingSettingsRequestSchema.parse({
      ownerType: 'user',
      ownerId: 'user-1',
      mode: 'cost_per_accuracy',
      pool,
      retryEntries: [{ model: 'c/d' }],
    });
    expect(parsed.retryEntries).toEqual([{ model: 'c/d' }]);
  });

  it('rejects retryEntries that are not in pool', () => {
    const result = UpdateAutoRoutingSettingsRequestSchema.safeParse({
      ownerType: 'user',
      ownerId: 'user-1',
      mode: null,
      pool: [{ model: 'a/b' }],
      retryEntries: [{ model: 'other/model' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects retryEntries when pool is null', () => {
    const result = UpdateAutoRoutingSettingsRequestSchema.safeParse({
      ownerType: 'user',
      ownerId: 'user-1',
      mode: null,
      pool: null,
      retryEntries: [{ model: 'a/b' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('benchmark profile request entry bounds', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    model: `model/${i}`,
  }));

  it('bounds RegisterBenchmarkProfilesRequestSchema entries at 10', () => {
    expect(
      RegisterBenchmarkProfilesRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'u1',
        entries: eleven,
      }).success
    ).toBe(false);
    expect(
      RegisterBenchmarkProfilesRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'u1',
        entries: eleven.slice(0, 10),
      }).success
    ).toBe(true);
  });

  it('bounds BenchmarkProfileStatusesRequestSchema entries at 10', () => {
    expect(BenchmarkProfileStatusesRequestSchema.safeParse({ entries: eleven }).success).toBe(
      false
    );
    expect(
      BenchmarkProfileStatusesRequestSchema.safeParse({ entries: eleven.slice(0, 1) }).success
    ).toBe(true);
  });

  it('accepts optional retryEntries that are a subset of entries', () => {
    const entries = [{ model: 'a/b' }, { model: 'c/d' }];
    expect(
      RegisterBenchmarkProfilesRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'u1',
        entries,
      }).success
    ).toBe(true);
    expect(
      RegisterBenchmarkProfilesRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'u1',
        entries,
        retryEntries: [{ model: 'a/b' }],
      }).success
    ).toBe(true);
  });

  it('rejects retryEntries that are not in entries', () => {
    const result = RegisterBenchmarkProfilesRequestSchema.safeParse({
      ownerType: 'org',
      ownerId: 'o1',
      entries: [{ model: 'a/b' }],
      retryEntries: [{ model: 'other/model' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('benchmark subscription request contracts', () => {
  const entries = [{ model: 'provider/model' }];

  it.each(['user', 'org'])('accepts %s subscription replacement and null removal', ownerType => {
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.parse({ ownerType, ownerId: 'owner-1', entries })
    ).toEqual({ ownerType, ownerId: 'owner-1', entries });
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.parse({
        ownerType,
        ownerId: 'owner-1',
        entries: null,
      })
    ).toEqual({ ownerType, ownerId: 'owner-1', entries: null });
  });

  it('preserves explicit compensation without enabling it for ordinary replacement', () => {
    const request = { ownerType: 'user', ownerId: 'owner-1', entries };
    expect(SyncBenchmarkSubscriptionsRequestSchema.parse(request)).not.toHaveProperty(
      'restorePrevious'
    );
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.parse({ ...request, restorePrevious: true })
    ).toEqual({ ...request, restorePrevious: true });
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.safeParse({ ...request, restorePrevious: 'true' })
        .success
    ).toBe(false);
  });

  it.each([
    { ownerType: 'user' },
    { ownerId: 'owner-1' },
    { ownerType: 'team', ownerId: 'owner-1' },
    { ownerType: 'user', ownerId: '   ' },
  ])('rejects invalid subscription owner identity %j', owner => {
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.safeParse({ ...owner, entries: null }).success
    ).toBe(false);
  });

  it('requires an explicit replacement or removal', () => {
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'owner-1',
      }).success
    ).toBe(false);
    expect(
      SyncBenchmarkSubscriptionsRequestSchema.safeParse({
        ownerType: 'user',
        ownerId: 'owner-1',
        entries: [],
      }).success
    ).toBe(false);
  });

  describe.each([
    ['status', BenchmarkProfileStatusesRequestSchema],
    ['custom table', CustomRoutingTableRequestSchema],
  ] as const)('%s owner identity', (_name, schema) => {
    it('accepts requests without owner identity', () => {
      expect(schema.safeParse({ entries }).success).toBe(true);
    });

    it.each(['user', 'org'])('preserves paired %s owner identity', ownerType => {
      expect(schema.parse({ entries, ownerType, ownerId: ' owner-1 ' })).toMatchObject({
        ownerType,
        ownerId: 'owner-1',
      });
    });

    it.each([
      [{ ownerType: 'user' }, 'ownerId'],
      [{ ownerId: 'owner-1' }, 'ownerType'],
    ])('rejects unpaired identity %j', (owner, missingField) => {
      const result = schema.safeParse({ entries, ...owner });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: [missingField] })
        );
      }
    });

    it.each([
      { ownerType: 'team', ownerId: 'owner-1' },
      { ownerType: 'user', ownerId: '   ' },
      { ownerType: null, ownerId: 'owner-1' },
      { ownerType: 'user', ownerId: null },
    ])('rejects invalid paired identity %j', owner => {
      expect(schema.safeParse({ entries, ...owner }).success).toBe(false);
    });
  });
});
