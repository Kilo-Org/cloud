import { describe, expect, test } from '@jest/globals';
import { describeStep } from './routing-labels';

describe('describeStep', () => {
  test('shows the key that served over another API as selected', () => {
    expect(
      describeStep({
        step: 'unsupported-api-kind',
        outcome: 'selected',
        provider_id: 'anthropic',
        supported_api_kinds: ['messages'],
      })
    ).toEqual({
      title: 'BYOK key over another API',
      detail:
        'No key serves this API, so the request went to the anthropic key, which supports messages.',
      tone: 'selected',
    });
  });

  test('names the gateway Kilo routed through', () => {
    expect(describeStep({ step: 'kilo', outcome: 'selected', gateway: 'openrouter' })).toEqual({
      title: 'Kilo gateway',
      detail: 'Paid with Kilo credits and routed through OpenRouter.',
      tone: 'selected',
    });
  });
});
