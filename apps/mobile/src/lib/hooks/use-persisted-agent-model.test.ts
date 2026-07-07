import { describe, expect, it } from 'vitest';

import {
  parseStoredModelPreference,
  resolveModelForContext,
  type StoredModelPreference,
} from './agent-model-preference';

const options = [
  { id: 'anthropic/claude', name: 'Claude', variants: ['thinking'], isPreferred: true },
  { id: 'openai/gpt', name: 'GPT', variants: [], isPreferred: false },
];

describe('parseStoredModelPreference', () => {
  it('returns empty map for invalid json', () => {
    expect(parseStoredModelPreference('not json')).toEqual({});
  });

  it('parses a valid record keyed by context', () => {
    const raw = JSON.stringify({ personal: { model: 'openai/gpt', variant: '' } });
    expect(parseStoredModelPreference(raw)).toEqual({
      personal: { model: 'openai/gpt', variant: '' },
    });
  });

  it('drops entries with non-string model', () => {
    const raw = JSON.stringify({ personal: { model: 42, variant: '' } });
    expect(parseStoredModelPreference(raw)).toEqual({});
  });
});

describe('resolveModelForContext', () => {
  const stored: StoredModelPreference = {
    personal: { model: 'openai/gpt', variant: '' },
    org_123: { model: 'deleted/model', variant: 'thinking' },
  };

  it('returns persisted model when it exists in options', () => {
    expect(resolveModelForContext(stored, 'personal', options)).toEqual({
      model: 'openai/gpt',
      variant: '',
    });
  });

  it('returns undefined when persisted model is not in options', () => {
    expect(resolveModelForContext(stored, 'org_123', options)).toBeUndefined();
  });

  it('resets variant when persisted variant no longer exists', () => {
    const s: StoredModelPreference = { personal: { model: 'anthropic/claude', variant: 'gone' } };
    expect(resolveModelForContext(s, 'personal', options)).toEqual({
      model: 'anthropic/claude',
      variant: 'thinking',
    });
  });

  it('returns undefined for unknown context', () => {
    expect(resolveModelForContext(stored, 'org_999', options)).toBeUndefined();
  });
});
