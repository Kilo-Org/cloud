import { describe, expect, test } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { computeSnapshotDiff } from '@/lib/ai-gateway/providers/openrouter/snapshot-diff';
import {
  buildAutoChangeMessage,
  computeRelevantChangesForOrg,
  relevantChangesIsEmpty,
} from '@/lib/organizations/auto-model-change-log';

function buildSnapshot(
  providers: Array<{ slug: string; models: string[] }>
): NormalizedOpenRouterResponse {
  const mapped: NormalizedProvider[] = providers.map(({ slug, models }) => ({
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: models.map(modelSlug => ({
      slug: modelSlug,
      name: modelSlug,
      author: slug,
      description: '',
      context_length: 0,
      input_modalities: [],
      output_modalities: [],
      group: 'other',
      updated_at: '',
      endpoint: {
        provider_display_name: slug,
        is_free: false,
        pricing: { prompt: '0', completion: '0' },
      },
    })),
  }));

  return {
    providers: mapped,
    total_providers: mapped.length,
    total_models: mapped.reduce((sum, p) => sum + p.models.length, 0),
    generated_at: '2026-01-01T00:00:00Z',
  };
}

function buildEnterpriseOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: `org-${Math.random()}`,
    name: 'Test Enterprise Org',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
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
    plan: 'enterprise',
    free_trial_end_at: null,
    company_domain: null,
    ...overrides,
  } satisfies Organization;
}

describe('computeRelevantChangesForOrg', () => {
  test('allow-list mode: new model from already-allowed provider is relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(changes.addedByReasonProvider.get('z-ai')).toEqual(['z-ai/glm-5.1']);
    expect(changes.removedFromCatalog).toEqual([]);
    expect(changes.removedFromAllowedProviders).toEqual([]);
  });

  test('allow-list mode: new model from non-allowed provider is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
      { slug: 'openai', models: ['openai/gpt-4o'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('allow-list mode: brand-new provider with new model is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
      { slug: 'new-provider', models: ['new-provider/foo'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('allow-list mode: new model on the deny list is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
        model_deny_list: ['z-ai/glm-5.1'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5', 'z-ai/glm-5.1'] }]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('legacy deny-list mode (empty deny lists): new model from any provider is relevant', () => {
    const org = buildEnterpriseOrg({ settings: {} });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'z-ai', models: ['z-ai/glm-5'] },
      { slug: 'new-provider', models: ['new-provider/foo'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(changes.addedByReasonProvider.get('new-provider')).toEqual(['new-provider/foo']);
  });

  test('legacy deny-list mode: new model from denied provider is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: { provider_deny_list: ['bad-corp'] },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'bad-corp', models: ['bad-corp/old'] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'bad-corp', models: ['bad-corp/old', 'bad-corp/new'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('removed from catalog: model that was accessible is recorded', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(changes.removedFromCatalog).toEqual(['z-ai/glm-4.0']);
    expect(changes.removedFromAllowedProviders).toEqual([]);
  });

  test('removed from allowed providers: model still in catalog but only via denied providers', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai'],
      },
    });
    const oldSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'baidu', models: ['openai/gpt-4o'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: [] },
      { slug: 'baidu', models: ['openai/gpt-4o'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(changes.removedFromCatalog).toEqual([]);
    expect(changes.removedFromAllowedProviders).toEqual(['openai/gpt-4o']);
  });

  test('removed model that was denied is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['z-ai'],
        model_deny_list: ['z-ai/glm-4.0'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-4.0', 'z-ai/glm-5'] }]);
    const newSnapshot = buildSnapshot([{ slug: 'z-ai', models: ['z-ai/glm-5'] }]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('removed model still offered by another allowed provider is NOT relevant', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['openai', 'azure'],
      },
    });
    const oldSnapshot = buildSnapshot([
      { slug: 'openai', models: ['openai/gpt-4o'] },
      { slug: 'azure', models: ['openai/gpt-4o'] },
    ]);
    const newSnapshot = buildSnapshot([
      { slug: 'openai', models: [] },
      { slug: 'azure', models: ['openai/gpt-4o'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(relevantChangesIsEmpty(changes)).toBe(true);
  });

  test('deterministic reason provider: picks first alphabetical allowed provider', () => {
    const org = buildEnterpriseOrg({
      settings: {
        provider_policy_mode: 'allow',
        provider_allow_list: ['azure', 'openai'],
      },
    });
    const oldSnapshot = buildSnapshot([{ slug: 'azure', models: [] }]);
    const newSnapshot = buildSnapshot([
      { slug: 'azure', models: ['openai/gpt-5'] },
      { slug: 'openai', models: ['openai/gpt-5'] },
    ]);

    const diff = computeSnapshotDiff(oldSnapshot, newSnapshot);
    const changes = computeRelevantChangesForOrg(org, diff);

    expect(changes.addedByReasonProvider.get('azure')).toEqual(['openai/gpt-5']);
    expect(changes.addedByReasonProvider.has('openai')).toBe(false);
  });
});

describe('buildAutoChangeMessage', () => {
  test('only additions: formats one segment per provider', () => {
    const message = buildAutoChangeMessage({
      addedByReasonProvider: new Map([['z-ai', ['z-ai/glm-5.1', 'z-ai/glm-5.1-air']]]),
      removedFromCatalog: [],
      removedFromAllowedProviders: [],
    });

    expect(message).toBe('Added models from provider z-ai: z-ai/glm-5.1, z-ai/glm-5.1-air');
  });

  test('only catalog removals: formats one catalog-removal segment', () => {
    const message = buildAutoChangeMessage({
      addedByReasonProvider: new Map(),
      removedFromCatalog: ['z-ai/glm-4.0'],
      removedFromAllowedProviders: [],
    });

    expect(message).toBe('Removed models (no longer available): z-ai/glm-4.0');
  });

  test('only allowed-provider removals: formats one allowed-provider-removal segment', () => {
    const message = buildAutoChangeMessage({
      addedByReasonProvider: new Map(),
      removedFromCatalog: [],
      removedFromAllowedProviders: ['openai/gpt-4o'],
    });

    expect(message).toBe(
      'Removed models (no longer offered by any allowed provider): openai/gpt-4o'
    );
  });

  test('mixed additions and both removal kinds: providers sorted alphabetically', () => {
    const message = buildAutoChangeMessage({
      addedByReasonProvider: new Map([
        ['z-ai', ['z-ai/glm-5.1']],
        ['anthropic', ['anthropic/claude-4.6-haiku']],
      ]),
      removedFromCatalog: ['z-ai/glm-4.0'],
      removedFromAllowedProviders: ['openai/gpt-4o'],
    });

    expect(message).toBe(
      'Added models from provider anthropic: anthropic/claude-4.6-haiku; Added models from provider z-ai: z-ai/glm-5.1; Removed models (no longer available): z-ai/glm-4.0; Removed models (no longer offered by any allowed provider): openai/gpt-4o'
    );
  });

  test('empty input returns empty string', () => {
    const message = buildAutoChangeMessage({
      addedByReasonProvider: new Map(),
      removedFromCatalog: [],
      removedFromAllowedProviders: [],
    });

    expect(message).toBe('');
  });
});

describe('relevantChangesIsEmpty', () => {
  test('true when all three buckets are empty', () => {
    expect(
      relevantChangesIsEmpty({
        addedByReasonProvider: new Map(),
        removedFromCatalog: [],
        removedFromAllowedProviders: [],
      })
    ).toBe(true);
  });

  test('false when additions present', () => {
    expect(
      relevantChangesIsEmpty({
        addedByReasonProvider: new Map([['z-ai', ['z-ai/glm-5']]]),
        removedFromCatalog: [],
        removedFromAllowedProviders: [],
      })
    ).toBe(false);
  });

  test('false when catalog removals present', () => {
    expect(
      relevantChangesIsEmpty({
        addedByReasonProvider: new Map(),
        removedFromCatalog: ['z-ai/glm-4.0'],
        removedFromAllowedProviders: [],
      })
    ).toBe(false);
  });

  test('false when allowed-provider removals present', () => {
    expect(
      relevantChangesIsEmpty({
        addedByReasonProvider: new Map(),
        removedFromCatalog: [],
        removedFromAllowedProviders: ['openai/gpt-4o'],
      })
    ).toBe(false);
  });
});
