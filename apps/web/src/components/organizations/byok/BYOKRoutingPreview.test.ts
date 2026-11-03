import { describe, expect, it } from '@jest/globals';
import { describeRouteStep } from './BYOKRoutingPreview';

const NAMES: Record<string, string> = {
  'zai-coding': 'Z.ai Coding Plan',
  anthropic: 'Anthropic',
  bedrock: 'AWS Bedrock',
  openrouter: 'OpenRouter',
  openai: 'OpenAI API key',
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
