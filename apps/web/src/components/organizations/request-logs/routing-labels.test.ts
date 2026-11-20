import { describe, expect, test } from '@jest/globals';
import type { RequestLogRoutingResult } from '@/lib/request-logs/routing-details';
import {
  byokSkipReasonLabel,
  describeResult,
  describeStep,
  describeUnsentResult,
  gatewayName,
  rejectedResultLabel,
} from './routing-labels';

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

  test('names the partner Kilo tries before its gateway', () => {
    expect(
      describeStep({
        step: 'kilo',
        outcome: 'selected',
        gateway: 'vercel',
        partner_inference_provider: 'acme-ai',
      })
    ).toEqual({
      title: 'Kilo credits',
      detail:
        'Paid with Kilo credits, with Acme Ai as the direct provider and Vercel AI Gateway as the fallback.',
      tone: 'selected',
    });
  });

  test.each([
    ['unsupported-api-kind', 'this API is not supported.'],
    ['server-features', 'the request uses plugins or server tools, which only the gateway runs.'],
    ['bounded-spending', 'the request carries a spend ceiling.'],
    ['openrouter-disabled', 'excluded by the organization gateway settings.'],
    ['provider-settings', 'excluded by provider settings.'],
    ['unsupported-reasoning-effort', 'the requested reasoning effort is not supported.'],
  ])('explains a partner skipped for %s', (reason, detail) => {
    expect(
      describeStep({
        step: 'partner',
        outcome: 'skipped',
        partner_inference_provider: 'acme-ai',
        reason,
      })
    ).toEqual({
      title: 'Direct provider',
      detail: `Acme Ai was skipped: ${detail}`,
      tone: 'skipped',
    });
  });

  test('explains a partner skip without naming a partner that was not recorded', () => {
    expect(
      describeStep({ step: 'partner', outcome: 'skipped', reason: 'provider-settings' }).detail
    ).toBe('Excluded by provider settings.');
  });

  test('shows an unknown partner skip reason as recorded', () => {
    expect(describeStep({ step: 'partner', outcome: 'skipped', reason: 'new-reason' }).detail).toBe(
      'new-reason'
    );
  });

  test('calls custom LLMs promotional models', () => {
    expect(describeStep({ step: 'custom-llm', outcome: 'skipped', reason: 'no-match' })).toEqual({
      title: 'Promotional model',
      detail: 'The requested model is not a promotional model.',
      tone: 'skipped',
    });
  });

  test('says the selected BYOK key was only tried first when the request failed over', () => {
    expect(
      describeStep(
        { step: 'byok-key', outcome: 'selected', route: 'vercel-byok', provider_id: 'openai' },
        { failedOver: true }
      ).detail
    ).toBe(
      'Tried the OpenAI API key through Vercel AI Gateway first. It failed, so the request failed over to the next BYOK key.'
    );
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

describe('private provider steps', () => {
  const privateProvider = 'private-a1b2c3d4e5';

  test('names the private provider that served the private provider model ID', () => {
    expect(
      describeStep({ step: 'direct-byok-model', outcome: 'selected', provider_id: privateProvider })
    ).toEqual({
      title: 'Private provider model ID',
      detail: 'Served with the Private provider a1b2c3d4e5.',
      tone: 'selected',
    });
  });

  test.each([
    ['no-organization', 'Private providers are only available to organizations.'],
    ['no-key', 'This organization has no Private provider a1b2c3d4e5.'],
    ['disabled', 'The Private provider a1b2c3d4e5 is disabled.'],
    ['unknown-model', 'The Private provider a1b2c3d4e5 does not offer the requested model.'],
    ['invalid-credentials', "The Private provider a1b2c3d4e5's credentials could not be used."],
  ])('explains the %s rejection', (reason, detail) => {
    expect(
      describeStep({
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: privateProvider,
        reason,
      })
    ).toEqual({ title: 'Private provider model ID', detail, tone: 'rejected' });
  });

  test('tells which catalog model ID a private provider that only serves catalog IDs needs', () => {
    expect(
      describeStep({
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: privateProvider,
        reason: 'catalog-only',
        catalog_model_id: 'openai/gpt-5',
      }).detail
    ).toBe(
      'The Private provider a1b2c3d4e5 only serves Kilo catalog model IDs; request openai/gpt-5 instead.'
    );
    expect(
      describeStep({
        step: 'direct-byok-model',
        outcome: 'rejected',
        provider_id: privateProvider,
        reason: 'catalog-only',
        catalog_model_id: null,
      }).detail
    ).toBe('The Private provider a1b2c3d4e5 only serves Kilo catalog model IDs.');
  });

  test('does not call a private provider a key in the BYOK key step', () => {
    expect(
      describeStep({
        step: 'byok-key',
        outcome: 'selected',
        route: 'direct-byok',
        provider_id: privateProvider,
      }).detail
    ).toBe('Served with the Private provider a1b2c3d4e5.');
  });

  test('says a private provider candidate is disabled rather than its key', () => {
    expect(byokSkipReasonLabel('disabled', privateProvider)).toBe('Private provider disabled');
    expect(byokSkipReasonLabel('not-catalog-mode', privateProvider)).toBe(
      'Private provider uses its own model IDs'
    );
    expect(byokSkipReasonLabel('disabled', 'synthetic')).toBe('Key disabled');
    expect(byokSkipReasonLabel('unsupported-api-kind', privateProvider)).toBe(
      'Does not support this API'
    );
  });

  test('labels an unusable credential for a key and a private provider alike', () => {
    expect(byokSkipReasonLabel('unusable-credential', 'synthetic')).toBe('Credential unusable');
    expect(byokSkipReasonLabel('unusable-credential', privateProvider)).toBe('Credential unusable');
  });

  test.each([
    ['byok-private-provider-unavailable', 'Rejected: the private provider is unavailable'],
    [
      'direct-byok-catalog-only',
      'Rejected: the key or private provider only serves Kilo catalog model IDs',
    ],
  ])('labels the %s result', (kind, label) => {
    expect(rejectedResultLabel({ kind })).toBe(label);
  });
});

describe('describeResult', () => {
  test('names the private provider and its payer', () => {
    expect(
      describeResult({
        kind: 'provider',
        route: 'direct-byok-model',
        provider_type: 'direct-byok',
        byok_provider_ids: ['private-a1b2c3d4e5'],
        payer: 'owner-byok-key',
        is_free: false,
      })
    ).toEqual({
      title: 'Sent to Private provider a1b2c3d4e5',
      paidBy: 'Private provider a1b2c3d4e5',
    });
  });

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

describe('describeResult for a partner', () => {
  const partnerResult: RequestLogRoutingResult = {
    kind: 'provider',
    route: 'kilo',
    provider_type: 'partner',
    byok_provider_ids: [],
    payer: 'kilo',
    is_free: false,
  };

  test('names the partner from its inference provider and bills Kilo credits', () => {
    expect(describeResult(partnerResult, 'mistral')).toEqual({
      title: 'Sent to Mistral',
      paidBy: 'Kilo credits',
    });
  });

  test('falls back to a generic label when the partner is not recorded', () => {
    expect(describeResult(partnerResult)).toEqual({
      title: 'Sent to the direct provider',
      paidBy: 'Kilo credits',
    });
  });
});

describe('describeUnsentResult', () => {
  const kiloResult = {
    kind: 'provider',
    route: 'kilo',
    provider_type: 'openrouter',
    byok_provider_ids: [],
    payer: 'kilo',
    is_free: false,
  };

  test.each([
    ['enkrypt-block', 'Not sent: blocked by the Enkrypt input guardrail'],
    ['enkrypt-unavailable', 'Not sent: the Enkrypt input guardrail was unavailable'],
    ['rejected-before-guardrail', 'Not sent: rejected before the Enkrypt input guardrail verdict'],
  ] as const)('names %s as the reason and the provider Kilo selected', (reason, title) => {
    expect(describeUnsentResult(kiloResult, reason)).toEqual({
      title,
      detail: 'Would have been sent to OpenRouter.',
    });
  });

  test('names the direct BYOK provider that would have served', () => {
    expect(
      describeUnsentResult(
        {
          kind: 'provider',
          route: 'direct-byok',
          provider_type: 'direct-byok',
          byok_provider_ids: ['bedrock-byok'],
          payer: 'owner-byok-key',
          is_free: false,
        },
        'enkrypt-block'
      ).detail
    ).toBe('Would have been sent to Amazon Bedrock (direct).');
  });

  test('names the private provider that would have served', () => {
    expect(
      describeUnsentResult(
        {
          kind: 'provider',
          route: 'direct-byok',
          provider_type: 'direct-byok',
          byok_provider_ids: ['private-a1b2c3d4e5'],
          payer: 'owner-byok-key',
          is_free: false,
        },
        'enkrypt-block'
      ).detail
    ).toBe('Would have been sent to Private provider a1b2c3d4e5.');
  });

  test('omits the detail when the provider was not recorded', () => {
    expect(describeUnsentResult({ kind: 'provider' }, 'enkrypt-block')).toEqual({
      title: 'Not sent: blocked by the Enkrypt input guardrail',
      detail: null,
    });
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
