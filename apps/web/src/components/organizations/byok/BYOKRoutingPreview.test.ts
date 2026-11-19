import { describe, expect, it } from '@jest/globals';
import { describeRouteStep, isRoutingPreviewModelId } from './BYOKRoutingPreview';

const NAMES: Record<string, string> = {
  'zai-coding': 'Z.ai Coding Plan',
  anthropic: 'Anthropic',
  bedrock: 'AWS Bedrock',
  openrouter: 'OpenRouter',
  openai: 'OpenAI API key',
  'private-a1b2c3d4e5': 'Acme',
};

function getProviderName(providerId: string) {
  return NAMES[providerId] ?? providerId;
}

describe('describeRouteStep', () => {
  it('explains a catalog-mode key whose upstream lacks the API kind', () => {
    expect(
      describeRouteStep(
        {
          route: 'direct-byok',
          outcome: 'skipped',
          providerId: 'zai-coding',
          reason: 'unsupported-api-kind',
          supportedApiKinds: ['chat_completions'],
        },
        getProviderName,
        false
      )
    ).toEqual({
      title: 'Z.ai Coding Plan key',
      detail: 'Skipped: the provider serves this model over Chat Completions only.',
    });
  });

  it.each([
    [
      'unsupported-api-kind',
      'Skipped: the private provider serves this model over Chat Completions only.',
    ],
    ['disabled', 'Skipped: the private provider is disabled.'],
    [
      'not-catalog-mode',
      'Skipped: the private provider uses its own model IDs. Turn on Kilo catalog model IDs to use it for this model.',
    ],
  ] as const)('names an organization private provider skipped as %s', (reason, detail) => {
    expect(
      describeRouteStep(
        {
          route: 'direct-byok',
          outcome: 'skipped',
          providerId: 'private-a1b2c3d4e5',
          reason,
          supportedApiKinds: ['chat_completions'],
        },
        getProviderName,
        true
      )
    ).toEqual({ title: 'Acme private provider', detail });
  });

  it('names the key Vercel AI Gateway receives', () => {
    expect(
      describeRouteStep(
        {
          route: 'vercel-byok',
          outcome: 'used',
          providerIds: ['bedrock'],
          reason: 'serves',
        },
        getProviderName,
        false
      )
    ).toEqual({
      title: 'AWS Bedrock key via Vercel AI Gateway',
      detail: 'Serves this model with the key.',
    });
  });

  it('marks a serving route below the used one as not tried', () => {
    expect(
      describeRouteStep(
        { route: 'gateway-byok', outcome: 'unreached', providerId: 'openrouter', reason: 'serves' },
        getProviderName,
        false
      )
    ).toEqual({
      title: 'OpenRouter key',
      detail: 'Not tried: a route above serves this model.',
    });
  });

  it('describes the ChatGPT connection for the owner', () => {
    const step = { route: 'chatgpt', outcome: 'conditional' } as const;
    expect(describeRouteStep(step, getProviderName, false).detail).toBe(
      'Used when your ChatGPT connection is active.'
    );
    expect(describeRouteStep(step, getProviderName, true).detail).toBe(
      'Used when the member sending the request has connected ChatGPT for this organization.'
    );
  });

  it('names the gateway of the Kilo route', () => {
    expect(
      describeRouteStep(
        { route: 'kilo', outcome: 'used', gateway: 'vercel' },
        getProviderName,
        true
      )
    ).toEqual({ title: 'Kilo via Vercel AI Gateway', detail: 'Paid with Kilo credits.' });
  });

  it('keeps one "key" for display names that already name the credential', () => {
    expect(
      describeRouteStep(
        { route: 'vercel-byok', outcome: 'used', providerIds: ['openai'], reason: 'serves' },
        getProviderName,
        false
      ).title
    ).toBe('OpenAI API key via Vercel AI Gateway');
    expect(
      describeRouteStep(
        {
          route: 'vercel-byok',
          outcome: 'used',
          providerIds: ['anthropic', 'openai'],
          reason: 'serves',
        },
        getProviderName,
        false
      ).title
    ).toBe('Anthropic, OpenAI API keys via Vercel AI Gateway');
  });
});

describe('isRoutingPreviewModelId', () => {
  it.each(['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'kilo-auto/frontier'])(
    'offers the catalog model %s',
    modelId => {
      expect(isRoutingPreviewModelId(modelId)).toBe(true);
    }
  );

  it.each(['private-a1b2c3d4e5/my-model', 'private-a1b2c3d4e5/org/model', 'synthetic/hf:model'])(
    'does not offer the model %s, which the preview cannot route',
    modelId => {
      expect(isRoutingPreviewModelId(modelId)).toBe(false);
    }
  );

  it('offers an id that only resembles a private provider id', () => {
    expect(isRoutingPreviewModelId('private-short/model')).toBe(true);
    expect(isRoutingPreviewModelId('private-a1b2c3d4e5')).toBe(true);
  });
});
