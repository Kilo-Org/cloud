import { describe, expect, it } from '@jest/globals';
import {
  getLastUsedModelStorageKey,
  getLastUsedVariantsStorageKey,
  getPreferredInitialModel,
  getPreferredInitialVariant,
} from './model-preferences';
import type { ModelOption } from '@/components/shared/ModelCombobox';

const modelOptions = [
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-5.1', name: 'GPT 5.1' },
] satisfies ModelOption[];

describe('getPreferredInitialModel', () => {
  it('prefers the last used model when it is available', () => {
    expect(
      getPreferredInitialModel({
        modelOptions,
        lastUsedModel: 'openai/gpt-5.1',
        defaultModel: 'anthropic/claude-sonnet-4.5',
      })
    ).toBe('openai/gpt-5.1');
  });

  it('falls back to the org default when the last used model is unavailable', () => {
    expect(
      getPreferredInitialModel({
        modelOptions,
        lastUsedModel: 'blocked/model',
        defaultModel: 'anthropic/claude-sonnet-4.5',
      })
    ).toBe('anthropic/claude-sonnet-4.5');
  });

  it('falls back to the first available model when no preference is allowed', () => {
    expect(
      getPreferredInitialModel({
        modelOptions,
        lastUsedModel: null,
        defaultModel: 'blocked/model',
      })
    ).toBe('anthropic/claude-sonnet-4.5');
  });

  it('returns undefined when no models are available', () => {
    expect(
      getPreferredInitialModel({
        modelOptions: [],
        lastUsedModel: 'openai/gpt-5.1',
        defaultModel: 'anthropic/claude-sonnet-4.5',
      })
    ).toBeUndefined();
  });
});

describe('getLastUsedModelStorageKey', () => {
  it('uses separate keys for personal and organization contexts', () => {
    expect(getLastUsedModelStorageKey()).toBe('cloud-agent:last-used-model:personal');
    expect(getLastUsedModelStorageKey('org_123')).toBe(
      'cloud-agent:last-used-model:organization:org_123'
    );
  });
});

describe('getLastUsedVariantsStorageKey', () => {
  it('uses separate keys for personal and organization contexts', () => {
    expect(getLastUsedVariantsStorageKey()).toBe('cloud-agent:last-used-variants:personal');
    expect(getLastUsedVariantsStorageKey('org_123')).toBe(
      'cloud-agent:last-used-variants:organization:org_123'
    );
  });
});

describe('getPreferredInitialVariant', () => {
  it('prefers the last used variant when it is available', () => {
    expect(
      getPreferredInitialVariant({
        availableVariants: ['none', 'low', 'medium', 'high'],
        lastUsedVariant: 'high',
        currentVariant: 'low',
      })
    ).toBe('high');
  });

  it('preserves the current variant when no last used is recorded', () => {
    expect(
      getPreferredInitialVariant({
        availableVariants: ['none', 'low', 'medium', 'high'],
        lastUsedVariant: null,
        currentVariant: 'medium',
      })
    ).toBe('medium');
  });

  it('falls back to the first variant when the last used is unavailable and there is no current', () => {
    expect(
      getPreferredInitialVariant({
        availableVariants: ['none', 'low'],
        lastUsedVariant: 'max',
      })
    ).toBe('none');
  });

  it('ignores a current variant that is not available on the new model', () => {
    expect(
      getPreferredInitialVariant({
        availableVariants: ['none'],
        lastUsedVariant: null,
        currentVariant: 'high',
      })
    ).toBe('none');
  });

  it('returns undefined when no variants are available', () => {
    expect(
      getPreferredInitialVariant({
        availableVariants: [],
        lastUsedVariant: 'high',
        currentVariant: 'low',
      })
    ).toBeUndefined();
  });
});
