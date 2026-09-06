import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ModelStats, Organization } from '@kilocode/db/schema';
import type { EnkryptBenchmark } from '@kilocode/db/schema-types';
import type { OpenRouterModel, OpenRouterModelsResponse } from './organization-types';
import type {
  OrganizationGroupPolicyContext,
  OrganizationPolicySubject,
} from './organization-group-policy-context.server';
import type * as Producer from './organization-models';
import type * as Cache from '@/lib/model-stats/model-stats-cache';
import type * as Enkrypt from '@/lib/model-stats/enkrypt';
import { fingerprintEnkryptScore } from '@/lib/model-stats/enkrypt-fingerprint';

let mockPublicationEnabled = true;
let mockAutoEnabled = false;
let mockContext: OrganizationGroupPolicyContext;
let mockCatalog: OpenRouterModelsResponse & { fixtureCatalogMarker: string };
const mockReadRows = jest.fn<Promise<Cache.ModelStatsCacheEntry[]>, []>();
const mockReplicaSelect = jest.fn(() => {
  throw new Error('Unexpected replica query');
});
const mockGetContext = jest.fn(
  async (_params: { organizationId: string; subject: OrganizationPolicySubject }) => mockContext
);
const mockPolicy = { policyRevision: 7 };
const mockEvaluatePolicy = jest.fn((_context: OrganizationGroupPolicyContext) => mockPolicy);
const mockDecision = jest.fn(async (_policy: unknown, id: string) => ({
  allowed: id !== 'provider/blocked',
}));
const mockByok = jest.fn<Promise<OpenRouterModel[]>, [string]>();
const mockCustom = jest.fn<Promise<OpenRouterModel[]>, [string, readonly string[]]>();
const mockExperiments = jest.fn<Promise<OpenRouterModel[]>, []>();
const mockProviderIds = jest.fn(async (_db: unknown, _organizationId: string) => ['openai']);
const mockAvailability = jest.fn(async (models: OpenRouterModel[], _providers: string[]) =>
  models.map(model => ({ ...model, hasUserByokAvailable: model.id === 'provider/allowed' }))
);

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
}));
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: () => ({ orderBy: mockReadRows, leftJoin: () => ({ orderBy: mockReadRows }) }),
    })),
  },
  readDb: { select: mockReplicaSelect },
}));
jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(async () => mockCatalog),
  buildAutoModelCatalogEntry: jest.fn(() => catalogModel('kilo-auto/org')),
}));
jest.mock('@/lib/organizations/organization-group-policy-context.server', () => ({
  getOrganizationGroupPolicyContext: mockGetContext,
}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  evaluateEffectiveModelAccessPolicy: mockEvaluatePolicy,
  getEffectiveModelDecision: mockDecision,
}));
jest.mock('@/lib/ai-gateway/custom-llm/listAvailableCustomLlms', () => ({
  listAvailableCustomLlms: mockCustom,
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForOrganization: mockByok,
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: mockExperiments,
}));
jest.mock('@/lib/ai-gateway/auto-model', () => ({ ORG_AUTO_MODEL: { id: 'kilo-auto/org' } }));
jest.mock('@/lib/organizations/organization-auto-model', () => ({
  isOrganizationAutoEnabled: () => mockAutoEnabled,
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  addUserByokAvailability: mockAvailability,
  getOrganizationByokProviderIds: mockProviderIds,
}));

const checkedAt = '2026-09-01T00:00:00.000Z';
const benchmark: EnkryptBenchmark = {
  model_name: 'Fixture model',
  provider: 'Fixture provider',
  risk_score: 0,
  bias_score: null,
  ingestedAt: '2026-08-27T00:00:00.000Z',
  evaluatedAt: null,
};
const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
const subject: OrganizationPolicySubject = { type: 'member', kiloUserId: 'fixture-user' };
const terminalBench = { overallScore: 0.7, avgAttemptCostUsd: 12 };

function catalogModel(id: string, overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: 'Fixture model',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'fixture' },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0.01', completion: '0.02' },
    context_length: 1000,
    terminalBench,
    mayTrainOnYourPrompts: false,
    ...overrides,
  };
}

function entry(
  id = 'provider/allowed',
  score = benchmark,
  check: unknown = verification,
  isStealth = false
): Cache.ModelStatsCacheEntry {
  return {
    stat: {
      openrouterId: id,
      isActive: true,
      isStealth,
      benchmarks: { enkrypt: score },
      openrouterData: {},
    } as ModelStats,
    verification: check,
  };
}

function organization(): Organization {
  return {
    id: 'fixture-org',
    name: 'Fixture organization',
    created_at: checkedAt,
    updated_at: checkedAt,
    microdollars_used: 0,
    microdollars_balance: 0,
    total_microdollars_acquired: 0,
    next_credit_expiration_at: null,
    stripe_customer_id: null,
    auto_top_up_enabled: false,
    settings: {},
    seat_count: 0,
    require_seats: false,
    created_by_kilo_user_id: null,
    deleted_at: null,
    sso_domain: null,
    parent_organization_id: null,
    plan: 'enterprise',
    free_trial_end_at: null,
    company_domain: null,
  };
}

let producer: typeof Producer;
let cache: typeof Cache;
let enkrypt: typeof Enkrypt;
let mockFetch: jest.SpiedFunction<typeof fetch>;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse(checkedAt));
  mockFetch = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected network request'));
  mockPublicationEnabled = true;
  mockAutoEnabled = false;
  mockContext = {
    organization: organization(),
    groupIds: ['fixture-group'],
    defaultPolicies: [{ type: 'model_access', data: { mode: 'none' } }],
    groupPolicies: [
      [
        {
          type: 'model_access',
          data: {
            mode: 'selected',
            model_allow_list: ['provider/allowed'],
            provider_allow_list: [],
          },
        },
      ],
    ],
    policyRevision: 7,
  };
  mockCatalog = {
    fixtureCatalogMarker: 'preserved',
    data: [
      catalogModel('provider/allowed'),
      catalogModel('provider/blocked'),
      catalogModel('provider/training', { mayTrainOnYourPrompts: true }),
    ],
  };
  mockReadRows.mockReset().mockResolvedValue([entry(), entry('provider/blocked')]);
  mockByok.mockReset().mockResolvedValue([catalogModel('morph-byok/private')]);
  mockCustom
    .mockReset()
    .mockResolvedValue([catalogModel('kilo-internal/private', { mayTrainOnYourPrompts: true })]);
  mockExperiments.mockReset().mockResolvedValue([catalogModel('partner/experiment')]);
  [producer, cache, enkrypt] = await Promise.all([
    import('./organization-models'),
    import('@/lib/model-stats/model-stats-cache'),
    import('@/lib/model-stats/enkrypt'),
  ]);
});

afterEach(() => {
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockReplicaSelect).not.toHaveBeenCalled();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function primeAnnotatedCatalog() {
  const snapshot = await enkrypt.getEnkryptBenchmarks();
  mockCatalog = { ...mockCatalog, data: enkrypt.publishEnkryptModels(mockCatalog.data, snapshot) };
  for (const model of mockCatalog.data) Object.freeze(model);
  Object.freeze(mockCatalog.data);
  expect(mockCatalog.data[0].enkrypt).toMatchObject({
    lastCheckedAt: checkedAt,
    freshness: 'fresh',
  });
}

function pauseAt(stage: 'byok' | 'custom') {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const models =
    stage === 'byok'
      ? [catalogModel('morph-byok/private')]
      : [catalogModel('kilo-internal/private', { mayTrainOnYourPrompts: true })];
  const lookup = stage === 'byok' ? mockByok : mockCustom;
  lookup.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return models;
  });
  return { entered: entered.promise, release: release.resolve };
}

async function resultFor(policySubject = subject) {
  const result = await producer.getAvailableModelsForOrganization('fixture-org', policySubject);
  if (!result) throw new Error('Expected organization catalog');
  expect(result).toHaveProperty('fixtureCatalogMarker', 'preserved');
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(verification.scoreHash);
  for (const field of ['verification', 'scoreHash', 'observedAt', 'generation', 'entries']) {
    expect(serialized).not.toContain(field);
  }
  return result;
}

describe('organization model producer publication', () => {
  describe.each(['byok', 'custom'] as const)('during %s lookup', stage => {
    describe.each(['expiry', 'invalidation'] as const)('%s', boundary => {
      it.each(['failure', 'hidden', 'verified'] as const)(
        'uses only final snapshot eligibility after %s refresh',
        async refresh => {
          await primeAnnotatedCatalog();
          const previouslyAnnotated = mockCatalog.data[0].enkrypt;
          const pending = pauseAt(stage);
          const response = resultFor();
          await pending.entered;
          expect(mockReadRows).toHaveBeenCalledTimes(1);
          if (boundary === 'expiry') jest.advanceTimersByTime(300_000);
          else cache.invalidateModelStatsCache();
          const updated = { ...benchmark, risk_score: 9 };
          const check = {
            checkedAt: new Date(Date.now()).toISOString(),
            scoreHash: fingerprintEnkryptScore(updated),
          };
          if (refresh === 'failure') mockReadRows.mockRejectedValue(new Error('Unavailable'));
          else
            mockReadRows.mockResolvedValue([
              entry('provider/allowed', updated, check, refresh === 'hidden'),
            ]);
          pending.release();
          const result = await response;
          expect(JSON.stringify(result)).not.toContain(check.scoreHash);
          const model = result.data.find(model => model.id === 'provider/allowed');
          expect(model).toBeDefined();
          expect(model?.terminalBench).toEqual(terminalBench);
          expect(model?.hasUserByokAvailable).toBe(true);
          if (refresh === 'verified')
            expect(model?.enkrypt).toMatchObject({
              risk_score: 9,
              lastCheckedAt: check.checkedAt,
              freshness: 'fresh',
            });
          else expect(model).not.toHaveProperty('enkrypt');
          expect(result.data.map(model => model.id)).toEqual([
            'provider/allowed',
            'provider/training',
            'morph-byok/private',
            'kilo-internal/private',
          ]);
          expect(mockCatalog.data[0].enkrypt).toBe(previouslyAnnotated);
          expect(mockReadRows).toHaveBeenCalledTimes(2);
        }
      );
    });

    it('honors publication disable after earlier annotation without another query', async () => {
      await primeAnnotatedCatalog();
      const pending = pauseAt(stage);
      const response = resultFor();
      await pending.entered;
      mockPublicationEnabled = false;
      pending.release();
      const result = await response;
      for (const model of result.data) expect(model).not.toHaveProperty('enkrypt');
      expect(mockCatalog.data[0].enkrypt).toBeDefined();
      expect(mockReadRows).toHaveBeenCalledTimes(1);
    });
  });

  it('preserves scoped policy decisions and explicit custom/BYOK access across repeated producer calls', async () => {
    await primeAnnotatedCatalog();
    mockAutoEnabled = true;
    const defaultSubject: OrganizationPolicySubject = { type: 'defaultAccess' };
    const results = await Promise.all([resultFor(), resultFor(defaultSubject), resultFor()]);
    expect(mockGetContext).toHaveBeenCalledWith({ organizationId: 'fixture-org', subject });
    expect(mockGetContext).toHaveBeenCalledWith({
      organizationId: 'fixture-org',
      subject: defaultSubject,
    });
    expect(mockEvaluatePolicy).toHaveBeenCalledWith(mockContext);
    expect(mockCustom).toHaveBeenCalledWith('fixture-org', ['fixture-group']);
    expect(mockByok).toHaveBeenCalledWith('fixture-org');
    expect(mockProviderIds).toHaveBeenCalledWith(expect.anything(), 'fixture-org');
    expect(mockAvailability).toHaveBeenCalledWith(
      [mockCatalog.data[0], mockCatalog.data[2]],
      ['openai']
    );
    expect(mockDecision.mock.calls.map(([policy, id]) => ({ policy, id }))).toEqual(
      expect.arrayContaining(mockCatalog.data.map(model => ({ policy: mockPolicy, id: model.id })))
    );
    expect(
      mockDecision.mock.calls.every(([, id]) => mockCatalog.data.some(model => model.id === id))
    ).toBe(true);
    for (const result of results) {
      expect(result.data.map(model => model.id)).toEqual([
        'provider/allowed',
        'provider/training',
        'kilo-auto/org',
        'morph-byok/private',
        'kilo-internal/private',
      ]);
      expect(result.data[0].enkrypt?.lastCheckedAt).toBe(checkedAt);
      expect(result.data[2]).not.toHaveProperty('enkrypt');
    }
    expect(mockExperiments).not.toHaveBeenCalled();
    expect(mockReadRows).toHaveBeenCalledTimes(1);
  });

  it.each(['teams-allow', 'teams-deny', 'enterprise'] as const)(
    'preserves %s visibility rules while stripping appended raw scores',
    async mode => {
      await primeAnnotatedCatalog();
      mockContext.organization.plan = mode === 'enterprise' ? 'enterprise' : 'teams';
      mockContext.organization.settings = mode === 'teams-deny' ? { data_collection: 'deny' } : {};
      const raw = mockCatalog.data[0].enkrypt;
      const custom = catalogModel('kilo-internal/private', {
        enkrypt: raw,
        mayTrainOnYourPrompts: true,
      });
      const byok = catalogModel('morph-byok/private', { enkrypt: raw, hasUserByokAvailable: true });
      const experiment = catalogModel('partner/experiment', { enkrypt: raw });
      mockCustom.mockResolvedValue([custom]);
      mockByok.mockResolvedValue([byok]);
      mockExperiments.mockResolvedValue([experiment]);
      const result = await resultFor();
      expect(result.data.some(model => model.id === 'provider/training')).toBe(
        mode !== 'teams-deny'
      );
      expect(result.data.some(model => model.id === experiment.id)).toBe(mode === 'teams-allow');
      expect(result.data.some(model => model.id === 'provider/blocked')).toBe(false);
      for (const input of [custom, byok, ...(mode === 'teams-allow' ? [experiment] : [])]) {
        const expected = { ...input };
        delete expected.enkrypt;
        expect(result.data.find(model => model.id === input.id)).toEqual(expected);
        expect(input.enkrypt).toBe(raw);
      }
      expect(mockReadRows).toHaveBeenCalledTimes(1);
    }
  );

  it('does not freshen new score content with an old mismatched verification', async () => {
    await primeAnnotatedCatalog();
    cache.invalidateModelStatsCache();
    mockReadRows.mockResolvedValue([
      entry('provider/allowed', { ...benchmark, risk_score: 9 }, verification),
    ]);
    const result = await resultFor();
    expect(result.data[0].enkrypt).toMatchObject({
      risk_score: 9,
      lastCheckedAt: benchmark.ingestedAt,
      freshness: 'stale',
    });
    expect(mockReadRows).toHaveBeenCalledTimes(2);
  });
});
