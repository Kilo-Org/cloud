import { describe, expect, test } from '@jest/globals';
import { describeResult, describeStep, gatewayName } from './routing-labels';

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
        'No key serves this API, so the request went to the Anthropic key, which supports Anthropic Messages.',
      tone: 'selected',
    });
  });

  test('names the gateway Kilo routed through', () => {
    expect(describeStep({ step: 'kilo', outcome: 'selected', gateway: 'openrouter' })).toEqual({
      title: 'Kilo credits',
      detail: 'Paid with Kilo credits and routed through OpenRouter.',
      tone: 'selected',
    });
  });

  test('calls custom LLMs promotional models', () => {
    expect(describeStep({ step: 'custom-llm', outcome: 'skipped', reason: 'no-match' })).toEqual({
      title: 'Promotional model',
      detail: 'The requested model is not a promotional model.',
      tone: 'skipped',
    });
  });

  test('names BYOK providers instead of showing their IDs and routes', () => {
    expect(
      describeStep({
        step: 'byok-key',
        outcome: 'selected',
        route: 'direct-byok',
        provider_id: 'bedrock-byok',
      }).detail
    ).toBe('Served with the Amazon Bedrock (direct) key.');
    expect(
      describeStep({
        step: 'byok-key',
        outcome: 'selected',
        route: 'vercel-byok',
        provider_id: 'openai',
      }).detail
    ).toBe('Served with the OpenAI API key through Vercel AI Gateway.');
    expect(
      describeStep({ step: 'organization-policy', excluded_provider_ids: ['opencode-go'] }).detail
    ).toBe('Excluded BYOK providers: OpenCode Go.');
  });

  test('describes the provider model ID check apart from the provider that served', () => {
    expect(
      describeStep({ step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' })
    ).toEqual({
      title: 'Provider model ID',
      detail: "The requested model is not a BYOK provider's own model ID.",
      tone: 'skipped',
    });
  });
});

describe('describeResult', () => {
  test('names the direct BYOK provider and its key as payer', () => {
    expect(
      describeResult({
        kind: 'provider',
        route: 'direct-byok',
        provider_type: 'direct-byok',
        byok_provider_ids: ['bedrock-byok'],
        payer: 'owner-byok-key',
        is_free: false,
      })
    ).toEqual({
      title: 'Sent to Amazon Bedrock (direct)',
      paidBy: 'Amazon Bedrock (direct) key',
    });
  });

  test.each([
    [false, 'Kilo credits'],
    [true, 'Free'],
  ])('bills a promotional model with is_free %s to %s', (isFree, paidBy) => {
    expect(
      describeResult({
        kind: 'provider',
        route: 'custom-llm',
        provider_type: 'custom-public',
        byok_provider_ids: [],
        payer: 'custom-llm-credential',
        is_free: isFree,
      })
    ).toEqual({ title: "Sent to the promotional model's provider", paidBy });
  });
});

describe('gatewayName', () => {
  test('names only OpenRouter and Vercel AI Gateway', () => {
    expect(gatewayName('openrouter')).toBe('OpenRouter');
    expect(gatewayName('vercel')).toBe('Vercel AI Gateway');
    expect(gatewayName('bedrock-byok')).toBeNull();
    expect(gatewayName('claude-billing')).toBeNull();
  });
});
