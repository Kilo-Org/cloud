import { describe, expect, it } from 'vitest';

import {
  normalizeInferenceProviderId,
  normalizeInferenceProviderIds,
} from './model-access-providers';

describe('normalizeInferenceProviderId', () => {
  it('lowercases a mixed-case slug', () => {
    expect(normalizeInferenceProviderId('OpenAI')).toBe('openai');
  });

  it('cuts a model-shaped entry at its first slash', () => {
    expect(normalizeInferenceProviderId('openai/gpt-4o')).toBe('openai');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeInferenceProviderId('  Anthropic  ')).toBe('anthropic');
  });

  it('leaves an already canonical slug unchanged', () => {
    expect(normalizeInferenceProviderId('amazon-bedrock')).toBe('amazon-bedrock');
  });
});

describe('normalizeInferenceProviderIds', () => {
  it('lowercases every entry', () => {
    expect(normalizeInferenceProviderIds(['OpenAI'])).toEqual(['openai']);
  });

  it('cuts a model-shaped entry at its first slash', () => {
    expect(normalizeInferenceProviderIds(['openai/gpt-4o'])).toEqual(['openai']);
  });

  it('trims every entry', () => {
    expect(normalizeInferenceProviderIds([' openai ', '\tanthropic'])).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('drops blank entries and entries that name no provider', () => {
    expect(normalizeInferenceProviderIds(['', '   ', '/x', 'openai'])).toEqual(['openai']);
  });

  it('keeps the first occurrence of a slug and preserves order', () => {
    expect(normalizeInferenceProviderIds(['Anthropic', 'openai', 'anthropic', 'OpenAI'])).toEqual([
      'anthropic',
      'openai',
    ]);
  });

  it('collapses entries that normalize to the same slug', () => {
    expect(normalizeInferenceProviderIds(['openai', 'openai/gpt-4o', ' OpenAI '])).toEqual([
      'openai',
    ]);
  });
});
