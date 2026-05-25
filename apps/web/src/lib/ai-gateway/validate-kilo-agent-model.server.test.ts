import { describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { isKiloAgentModelAvailable } from './validate-kilo-agent-model.server';

function makeModel(
  id: string,
  options: { supportedParameters?: string[]; outputModalities?: string[] } = {}
): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: options.outputModalities ?? ['text'],
      tokenizer: 'test',
    },
    top_provider: {
      is_moderated: false,
      context_length: null,
      max_completion_tokens: null,
    },
    pricing: {
      prompt: '0',
      completion: '0',
    },
    context_length: 0,
    supported_parameters: options.supportedParameters ?? ['tools'],
  };
}

describe('isKiloAgentModelAvailable', () => {
  test('accepts an exact listed model', () => {
    expect(
      isKiloAgentModelAvailable('anthropic/claude-sonnet', [makeModel('anthropic/claude-sonnet')])
    ).toBe(true);
  });

  test('rejects a model that is not listed exactly', () => {
    expect(
      isKiloAgentModelAvailable('anthropic/claude', [makeModel('anthropic/claude-sonnet')])
    ).toBe(false);
  });

  test('accepts a listed model regardless of advertised tool capability', () => {
    expect(
      isKiloAgentModelAvailable('anthropic/claude-sonnet', [
        makeModel('anthropic/claude-sonnet', { supportedParameters: ['temperature'] }),
      ])
    ).toBe(true);
  });

  test('accepts a listed model regardless of output modalities', () => {
    expect(
      isKiloAgentModelAvailable('image/model', [
        makeModel('image/model', { outputModalities: ['text', 'image'] }),
      ])
    ).toBe(true);
  });
});
