import { describe, expect, it } from 'vitest';
import {
  AUTO_DECISION_HEADER,
  AUTO_DECISION_TTL_MS,
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  ClientCustomRouterEntrySchema,
  ClientEvalPlanResponseSchema,
  ClientEvalResultResponseSchema,
  CustomRouterBenchmarkContextSchema,
  InternalClientEvalResultRequestSchema,
  CreateCustomRouterRequestSchema,
  CustomRouterDecideRequestSchema,
  CustomRouterDecideResponseSchema,
  CustomRouterDefinitionSchema,
  CustomRouterEntriesSchema,
  CustomRouterErrorCodeSchema,
  CustomRouterErrorResponseSchema,
  CustomRouterSummarySchema,
  GatewayCustomRouterEntrySchema,
  MAX_CLIENT_CONTEXT_LENGTH,
  MAX_CLIENT_INPUT_MODALITIES,
  MAX_CLIENT_INPUT_MODALITY_LENGTH,
  MAX_CLIENT_PRICE_PER_MTOK_USD,
  MAX_CLIENT_VARIANTS,
  MAX_CLIENT_VARIANT_LENGTH,
  MAX_CUSTOM_ROUTER_ENTRY_KEY_LENGTH,
  MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH,
  MAX_CUSTOM_ROUTER_PROVIDER_ID_LENGTH,
  RegisterClientEntryRequestSchema,
  UpdateCustomRouterRequestSchema,
  customRouterCandidateModel,
  customRouterClientEntriesPath,
  customRouterEntryKey,
  customRouterEntryRef,
  customRouterModelId,
  customRouterPath,
  parseCustomRouterCandidateModel,
  parseCustomRouterModelId,
  signAutoDecision,
  verifyAutoDecision,
  type AutoDecisionPayload,
  type ClientCustomRouterEntry,
  type CustomRouterEntry,
} from './custom-router';

const clientEntry: ClientCustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: [],
  capabilities: {
    contextLength: 32_768,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: false,
  },
  pricing: null,
};

const gatewayEntry: CustomRouterEntry = { kind: 'gateway', model: 'anthropic/claude-sonnet-4' };

const DECISION_SECRET = 'test-decision-secret';

const decisionPayload: AutoDecisionPayload = {
  userId: 'oauth/user-1',
  organizationId: null,
  routerModelId: 'kilo-auto/custom/org/my-router',
  model: 'anthropic/claude-sonnet-4',
  variant: 'high',
  expiresAt: 2_000,
};

describe('custom router model IDs', () => {
  it('round trips personal and organization slugs', () => {
    expect(customRouterModelId('user', 'my-router')).toBe('kilo-auto/custom/my-router');
    expect(customRouterModelId('org', 'my-router')).toBe('kilo-auto/custom/org/my-router');
    expect(parseCustomRouterModelId('kilo-auto/custom/my-router')).toEqual({
      scope: 'user',
      slug: 'my-router',
    });
    expect(parseCustomRouterModelId('kilo-auto/custom/org/my-router')).toEqual({
      scope: 'org',
      slug: 'my-router',
    });
  });

  it('rejects the reserved personal slug and malformed model IDs', () => {
    expect(parseCustomRouterModelId('kilo-auto/custom/org')).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/custom/My-Router')).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/custom/-leading')).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/custom/')).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/efficient')).toBeNull();
    expect(parseCustomRouterModelId('openai/gpt-5')).toBeNull();
    expect(parseCustomRouterModelId(`kilo-auto/custom/${'a'.repeat(41)}`)).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/custom/org')).toBeNull();
    expect(parseCustomRouterModelId('kilo-auto/custom/org/')).toBeNull();
  });
});

describe('custom router entry keys', () => {
  it('keys gateway and client entries and converts them to candidate models', () => {
    expect(customRouterEntryKey(gatewayEntry)).toBe('gateway:anthropic/claude-sonnet-4');
    expect(customRouterEntryKey(clientEntry)).toBe('client:ollama/qwen3:32b');
    expect(customRouterCandidateModel(clientEntry)).toBe('client:ollama/qwen3:32b');
    expect(customRouterCandidateModel(gatewayEntry)).toBe('anthropic/claude-sonnet-4');
  });

  it('parses candidate models back into entry refs', () => {
    expect(parseCustomRouterCandidateModel('client:ollama/qwen3:32b')).toEqual({
      kind: 'client',
      provider: 'ollama',
      model: 'qwen3:32b',
    });
    expect(parseCustomRouterCandidateModel('client:openrouter/vendor/model:free')).toEqual({
      kind: 'client',
      provider: 'openrouter',
      model: 'vendor/model:free',
    });
    expect(parseCustomRouterCandidateModel('anthropic/claude-sonnet-4')).toEqual(gatewayEntry);
    expect(parseCustomRouterCandidateModel('client:ollama')).toBeNull();
    expect(parseCustomRouterCandidateModel('client:/model')).toBeNull();
    expect(parseCustomRouterCandidateModel('client:ollama/')).toBeNull();
    expect(parseCustomRouterCandidateModel('')).toBeNull();
  });

  it('keeps the candidate namespace injective by reserving the client prefix', () => {
    expect(
      GatewayCustomRouterEntrySchema.safeParse({ kind: 'gateway', model: 'client:ollama/qwen3' })
        .success
    ).toBe(false);
    expect(parseCustomRouterCandidateModel('client:ollama/qwen3')).toEqual({
      kind: 'client',
      provider: 'ollama',
      model: 'qwen3',
    });
    expect(customRouterCandidateModel(gatewayEntry)).toBe('anthropic/claude-sonnet-4');
  });

  it('strips client fields when building an entry ref', () => {
    expect(customRouterEntryRef(clientEntry)).toEqual({
      kind: 'client',
      provider: 'ollama',
      model: 'qwen3:32b',
    });
  });
});

describe('custom router entries', () => {
  it('rejects duplicate keys, over-long pools, and client providers with a slash', () => {
    expect(CustomRouterEntriesSchema.safeParse([gatewayEntry, gatewayEntry]).success).toBe(false);
    expect(
      CustomRouterEntriesSchema.safeParse(
        Array.from({ length: 21 }, (_, index) => ({ kind: 'gateway', model: `model-${index}` }))
      ).success
    ).toBe(false);
    expect(CustomRouterEntriesSchema.safeParse([]).success).toBe(false);
    expect(
      ClientCustomRouterEntrySchema.safeParse({ ...clientEntry, provider: 'local/server' }).success
    ).toBe(false);
    expect(
      ClientCustomRouterEntrySchema.safeParse({ ...clientEntry, variants: ['x', 'x'] }).success
    ).toBe(false);
    expect(CustomRouterEntriesSchema.safeParse([gatewayEntry, clientEntry]).success).toBe(true);
  });
});

describe('custom router entry budget', () => {
  const atModelLimit = 'a'.repeat(MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH);
  const client = (overrides: Record<string, unknown> = {}) => ({ ...clientEntry, ...overrides });
  const registration = (overrides: Record<string, unknown> = {}) =>
    RegisterClientEntryRequestSchema.safeParse({ entry: client(overrides) });

  it('accepts a maximal realistic client entry and refuses one unit past each bound', () => {
    expect(
      registration({
        provider: 'p'.repeat(MAX_CUSTOM_ROUTER_PROVIDER_ID_LENGTH),
        model: atModelLimit,
        variants: ['v'.repeat(MAX_CLIENT_VARIANT_LENGTH)],
        capabilities: {
          contextLength: MAX_CLIENT_CONTEXT_LENGTH,
          inputModalities: ['m'.repeat(MAX_CLIENT_INPUT_MODALITY_LENGTH)],
          toolCall: true,
          reasoning: true,
        },
        pricing: {
          inputPerMTokUsd: MAX_CLIENT_PRICE_PER_MTOK_USD,
          outputPerMTokUsd: MAX_CLIENT_PRICE_PER_MTOK_USD,
          cacheReadPerMTokUsd: MAX_CLIENT_PRICE_PER_MTOK_USD,
        },
      }).success
    ).toBe(true);

    expect(registration({ model: `${atModelLimit}a` }).success).toBe(false);
    expect(
      registration({ provider: 'p'.repeat(MAX_CUSTOM_ROUTER_PROVIDER_ID_LENGTH + 1) }).success
    ).toBe(false);
  });

  it('names the bounded field in the issue path', () => {
    const result = registration({ model: `${atModelLimit}a` });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['entry', 'model']);
  });

  it('bounds the variant and modality collections', () => {
    const variants = Array.from({ length: MAX_CLIENT_VARIANTS }, (_, index) => `variant-${index}`);
    expect(registration({ variants }).success).toBe(true);
    expect(registration({ variants: [...variants, 'extra'] }).success).toBe(false);
    expect(registration({ variants: ['v'.repeat(MAX_CLIENT_VARIANT_LENGTH + 1)] }).success).toBe(
      false
    );

    const modalities = Array.from(
      { length: MAX_CLIENT_INPUT_MODALITIES },
      (_, index) => `modality-${index}`
    );
    expect(
      registration({
        capabilities: { ...clientEntry.capabilities, inputModalities: modalities },
      }).success
    ).toBe(true);
    expect(
      registration({
        capabilities: { ...clientEntry.capabilities, inputModalities: [...modalities, 'extra'] },
      }).success
    ).toBe(false);
    expect(
      registration({
        capabilities: {
          ...clientEntry.capabilities,
          inputModalities: ['m'.repeat(MAX_CLIENT_INPUT_MODALITY_LENGTH + 1)],
        },
      }).success
    ).toBe(false);
  });

  it('requires finite, bounded context lengths and prices', () => {
    const withCapabilities = (overrides: Record<string, unknown>) =>
      registration({ capabilities: { ...clientEntry.capabilities, ...overrides } }).success;
    const withPricing = (pricing: null | Record<string, unknown>) =>
      registration({ pricing }).success;

    expect(withCapabilities({ contextLength: null })).toBe(true);
    expect(withCapabilities({ contextLength: MAX_CLIENT_CONTEXT_LENGTH + 1 })).toBe(false);
    expect(withCapabilities({ contextLength: Number.POSITIVE_INFINITY })).toBe(false);
    expect(withPricing(null)).toBe(true);
    expect(withPricing({ inputPerMTokUsd: 0, outputPerMTokUsd: 0 })).toBe(true);
    expect(
      withPricing({ inputPerMTokUsd: MAX_CLIENT_PRICE_PER_MTOK_USD + 1, outputPerMTokUsd: 0 })
    ).toBe(false);
    expect(withPricing({ inputPerMTokUsd: Number.POSITIVE_INFINITY, outputPerMTokUsd: 0 })).toBe(
      false
    );
    expect(withPricing({ inputPerMTokUsd: 0, outputPerMTokUsd: Number.NaN })).toBe(false);
  });

  it('accepts a maximal realistic pool and bounds the default entry key on create', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      client({ model: `${'m'.repeat(MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH - 4)}${index}` })
    );
    const create = {
      scope: 'user' as const,
      slug: 'maximal',
      name: 'Maximal',
      baseRouter: 'efficient' as const,
      mode: 'cost_per_accuracy' as const,
      entries,
      defaultEntryKey: customRouterEntryKey(entries[0]),
    };

    expect(CreateCustomRouterRequestSchema.safeParse(create).success).toBe(true);
    expect(
      CreateCustomRouterRequestSchema.safeParse({
        ...create,
        entries: [gatewayEntry],
        defaultEntryKey: `gateway:${'a'.repeat(MAX_CUSTOM_ROUTER_ENTRY_KEY_LENGTH)}`,
      }).success
    ).toBe(false);
  });

  it('keeps parsing stored definitions and summaries outside the budget', () => {
    const stored = client({
      model: `${atModelLimit}a`,
      variants: ['v'.repeat(MAX_CLIENT_VARIANT_LENGTH + 1)],
    });
    const key = `client:ollama/${stored.model}`;

    expect(ClientCustomRouterEntrySchema.safeParse(stored).success).toBe(true);
    expect(
      CustomRouterDefinitionSchema.safeParse({
        ...definition,
        entries: [stored],
        defaultEntryKey: key,
      }).success
    ).toBe(true);
    expect(
      CustomRouterSummarySchema.safeParse({
        id: definition.id,
        scope: 'user',
        slug: 'my-router',
        name: 'My Router',
        modelId: 'kilo-auto/custom/my-router',
        baseRouter: 'efficient',
        mode: 'cost_per_accuracy',
        defaultEntryKey: key,
        canEdit: true,
        entries: [{ key, entry: stored, needsClientEval: true, variants: [] }],
      }).success
    ).toBe(true);
  });
});

const definition = {
  id: '3f0d6b1c-9c1e-4b6a-8e4d-2a0f7f5a1b2c',
  ownerType: 'user' as const,
  ownerId: 'oauth/user-1',
  slug: 'my-router',
  name: 'My Router',
  baseRouter: 'efficient' as const,
  mode: 'cost_per_accuracy' as const,
  entries: [gatewayEntry, clientEntry],
  defaultEntryKey: 'gateway:anthropic/claude-sonnet-4',
};

describe('CustomRouterDefinitionSchema', () => {
  it('accepts a definition whose default entry key names a pool entry', () => {
    expect(CustomRouterDefinitionSchema.parse(definition).entries).toHaveLength(2);
  });

  it('rejects a default entry key outside the pool and the reserved personal slug', () => {
    expect(
      CustomRouterDefinitionSchema.safeParse({ ...definition, defaultEntryKey: 'gateway:nope' })
        .success
    ).toBe(false);
    expect(CustomRouterDefinitionSchema.safeParse({ ...definition, slug: 'org' }).success).toBe(
      false
    );
    expect(
      CustomRouterDefinitionSchema.safeParse({
        ...definition,
        ownerType: 'org',
        ownerId: 'org-1',
        slug: 'org',
      }).success
    ).toBe(true);
  });
});

describe('web API request schemas', () => {
  it('validates create requests against the pool', () => {
    const create = {
      scope: 'user' as const,
      slug: 'my-router',
      name: 'My Router',
      baseRouter: 'efficient' as const,
      mode: 'cost_per_accuracy' as const,
      entries: [gatewayEntry, clientEntry],
      defaultEntryKey: 'gateway:anthropic/claude-sonnet-4',
    };
    expect(CreateCustomRouterRequestSchema.safeParse(create).success).toBe(true);
    expect(
      CreateCustomRouterRequestSchema.safeParse({ ...create, defaultEntryKey: 'missing' }).success
    ).toBe(false);
  });

  it('requires an update to change a field and keeps the default key inside the pool', () => {
    expect(UpdateCustomRouterRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateCustomRouterRequestSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(UpdateCustomRouterRequestSchema.safeParse({ entries: [gatewayEntry] }).success).toBe(
      false
    );
    expect(
      UpdateCustomRouterRequestSchema.safeParse({
        entries: [gatewayEntry],
        defaultEntryKey: 'nope',
      }).success
    ).toBe(false);
    expect(
      UpdateCustomRouterRequestSchema.safeParse({
        entries: [gatewayEntry],
        defaultEntryKey: 'gateway:anthropic/claude-sonnet-4',
      }).success
    ).toBe(true);
    expect(
      UpdateCustomRouterRequestSchema.safeParse({
        defaultEntryKey: 'gateway:anthropic/claude-sonnet-4',
      }).success
    ).toBe(true);
  });

  it('builds the web REST paths', () => {
    expect(customRouterPath('org', 'my-router')).toBe(
      '/api/auto-routing/custom-routers/org/my-router'
    );
    expect(customRouterClientEntriesPath('user', 'my-router')).toBe(
      '/api/auto-routing/custom-routers/user/my-router/client-entries'
    );
  });
});

describe('public decide API', () => {
  it('accepts a custom router model ID and rejects others', () => {
    const request = {
      model: 'kilo-auto/custom/org/my-router',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: null,
      clientEntries: [{ provider: 'ollama', model: 'qwen3:32b' }],
    };
    expect(CustomRouterDecideRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CustomRouterDecideRequestSchema.safeParse({ ...request, model: 'kilo-auto/efficient' })
        .success
    ).toBe(false);
  });

  it('rejects a response whose model does not name its entry', () => {
    const response = {
      decision: {
        entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
        model: 'ollama/qwen3:32b',
        variant: null,
        stale: false,
        fallback: false,
        sticky: false,
        taskType: null,
        subtaskType: null,
        tableVersion: null,
      },
      decisionId: 'v1.abc.def',
    };
    expect(CustomRouterDecideResponseSchema.safeParse(response).success).toBe(false);
    expect(
      CustomRouterDecideResponseSchema.safeParse({
        ...response,
        decision: { ...response.decision, model: 'client:ollama/qwen3:32b' },
      }).success
    ).toBe(true);
  });

  it('keeps the classification on a fallback decision', () => {
    const decision = {
      entry: { kind: 'gateway', model: 'anthropic/claude-sonnet-4' },
      model: 'anthropic/claude-sonnet-4',
      variant: null,
      stale: false,
      fallback: true,
      sticky: false,
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
      tableVersion: null,
    };
    expect(
      CustomRouterDecideResponseSchema.parse({ decision, decisionId: 'v1.abc.def' }).decision
    ).toMatchObject({ fallback: true, taskType: 'debugging', subtaskType: 'bug_fixing' });
  });

  it('maps every error code to a status', () => {
    for (const code of CustomRouterErrorCodeSchema.options) {
      expect(CUSTOM_ROUTER_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(
        CustomRouterErrorResponseSchema.safeParse({ error: { code, message: 'nope' } }).success
      ).toBe(true);
    }
    expect(CUSTOM_ROUTER_ERROR_HTTP_STATUS.custom_router_unavailable).toBe(422);
    expect(CUSTOM_ROUTER_ERROR_HTTP_STATUS.quota_exceeded).toBe(429);
    expect(
      CustomRouterErrorResponseSchema.parse({
        error: { code: 'quota_exceeded', message: 'm', retryAt: '2026-10-17T00:00:00.000Z' },
      }).error.retryAt
    ).toBe('2026-10-17T00:00:00.000Z');
  });
});

describe('auto decision tokens', () => {
  it('round trips a signed payload', async () => {
    const token = await signAutoDecision(decisionPayload, DECISION_SECRET);
    expect(token.startsWith('v1.')).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(AUTO_DECISION_HEADER).toBe('x-kilo-auto-decision');
    await expect(verifyAutoDecision(token, DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: true,
      payload: decisionPayload,
    });
  });

  it('rejects a tampered payload in constant time', async () => {
    const token = await signAutoDecision(decisionPayload, DECISION_SECRET);
    const [version, payload, signature] = token.split('.');
    const flip = (value: string, at: number) =>
      `${value.slice(0, at)}${value[at] === 'B' ? 'C' : 'B'}${value.slice(at + 1)}`;
    await expect(
      verifyAutoDecision(`${version}.${flip(payload, 8)}.${signature}`, DECISION_SECRET, 1_000)
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(
      verifyAutoDecision(`${version}.${payload}.${flip(signature, 8)}`, DECISION_SECRET, 1_000)
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token whose signature or payload is non-canonical', async () => {
    const token = await signAutoDecision(decisionPayload, DECISION_SECRET);
    const [version, payload, signature] = token.split('.');
    await expect(
      verifyAutoDecision(`${version}.${payload}.${signature.slice(0, -1)}`, DECISION_SECRET, 1_000)
    ).resolves.toEqual({ ok: false, reason: 'malformed' });
    await expect(
      verifyAutoDecision(`${version}.${payload}.${signature}=`, DECISION_SECRET, 1_000)
    ).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a signature from another secret', async () => {
    const token = await signAutoDecision(decisionPayload, 'other-secret');
    await expect(verifyAutoDecision(token, DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a token whose expiry exceeds the decision lifetime', async () => {
    const nowMs = 1_000;
    const longLived = await signAutoDecision(
      { ...decisionPayload, expiresAt: nowMs + AUTO_DECISION_TTL_MS + 60_000 },
      DECISION_SECRET
    );
    await expect(verifyAutoDecision(longLived, DECISION_SECRET, nowMs)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
    const fullLifetime = await signAutoDecision(
      { ...decisionPayload, expiresAt: nowMs + AUTO_DECISION_TTL_MS },
      DECISION_SECRET
    );
    await expect(verifyAutoDecision(fullLifetime, DECISION_SECRET, nowMs)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('rejects expired and malformed tokens', async () => {
    const expired = await signAutoDecision(
      { ...decisionPayload, expiresAt: 1_000 },
      DECISION_SECRET
    );
    await expect(verifyAutoDecision(expired, DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
    await expect(verifyAutoDecision('nonsense', DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
    await expect(verifyAutoDecision('v2.a.b', DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
    await expect(verifyAutoDecision('v1.!!!.!!!', DECISION_SECRET, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
    const valid = await signAutoDecision(decisionPayload, DECISION_SECRET);
    await expect(
      verifyAutoDecision(`v1.${valid.split('.')[1]}.${valid.split('.')[2]}`, 'y', 2_000)
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('client eval schemas', () => {
  it('carries entry refs in a plan item and a bare score in the result response', () => {
    expect(
      ClientEvalPlanResponseSchema.safeParse({
        baseRouter: 'efficient',
        engineIdentity: 'router:v4:datasetHash',
        repetitions: 3,
        items: [
          {
            entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
            variant: null,
            caseId: 'case-1',
            rep: 0,
          },
        ],
      }).success
    ).toBe(true);
    expect(ClientEvalResultResponseSchema.safeParse({ score: 0.5 }).success).toBe(true);
    expect(ClientEvalResultResponseSchema.safeParse({ score: 1.5 }).success).toBe(false);
  });
});

describe('internal custom router context', () => {
  const clientKey = customRouterEntryKey(clientEntry);
  const context = {
    ownerType: 'org',
    ownerId: 'org-1',
    baseRouter: 'frontier',
    entries: [gatewayEntry, clientEntry],
    clientEvalEntryKeys: [clientKey],
  };

  it('requires every client entry to be measured by the owner CLI', () => {
    expect(CustomRouterBenchmarkContextSchema.safeParse(context).success).toBe(true);
    const unlisted = CustomRouterBenchmarkContextSchema.safeParse({
      ...context,
      clientEvalEntryKeys: [],
    });
    expect(unlisted.error?.issues.map(issue => issue.path)).toEqual([['entries', 1]]);
  });

  it('rejects client eval keys outside the pool and duplicates', () => {
    const result = CustomRouterBenchmarkContextSchema.safeParse({
      ...context,
      clientEvalEntryKeys: [clientKey, clientKey, 'gateway:other/model'],
    });
    expect(result.error?.issues.map(issue => issue.path)).toEqual([
      ['clientEvalEntryKeys', 1],
      ['clientEvalEntryKeys', 2],
    ]);
  });

  it('accepts uploads only for entries the owner CLI measures', () => {
    const upload = {
      ...context,
      routerId: '00000000-0000-4000-8000-000000000000',
      engineIdentity: 'frontier:v4:datasetHash',
      variant: null,
      caseId: 'case-1',
      rep: 0,
      output: 'answer',
      costUsd: 0,
      durationMs: 10,
      exitCode: 0,
      timedOut: false,
      billing: { userId: 'user-1', organizationId: 'org-1' },
    };
    expect(
      InternalClientEvalResultRequestSchema.safeParse({
        ...upload,
        entry: customRouterEntryRef(clientEntry),
      }).success
    ).toBe(true);
    const platformMeasured = InternalClientEvalResultRequestSchema.safeParse({
      ...upload,
      entry: gatewayEntry,
    });
    expect(platformMeasured.error?.issues.map(issue => issue.path)).toEqual([['entry']]);
  });
});
