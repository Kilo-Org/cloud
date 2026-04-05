import { describe, expect, test } from '@jest/globals';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { getDefaultSelectedModel } from '@/app/(app)/claw/hooks/useDefaultModelSelection';

const options: ModelOption[] = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
];

describe('getDefaultSelectedModel', () => {
  test('returns empty string when no model options are available', () => {
    expect(getDefaultSelectedModel('kilocode/openai/gpt-4.1', [])).toBe('');
  });

  test('returns empty string when config model is missing kilocode prefix', () => {
    expect(getDefaultSelectedModel('openai/gpt-4.1', options)).toBe('');
  });

  test('returns empty string when default model is not in options', () => {
    expect(getDefaultSelectedModel('kilocode/unknown/model', options)).toBe('');
  });

  test('returns stripped model id when default model exists in options', () => {
    expect(getDefaultSelectedModel('kilocode/openai/gpt-4.1', options)).toBe('openai/gpt-4.1');
  });
});
