import { describe, expect, it } from '@jest/globals';
import { providerDisplayNames } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/provider-display-names';

function snapshotOf(providers: { slug: string; displayName: string }[]) {
  return { providers };
}

describe('providerDisplayNames', () => {
  it('names no providers when no snapshot is stored yet', () => {
    expect(providerDisplayNames(null)).toEqual([]);
  });

  it('lowercases the slug so a mixed-case provider matches a model provider id', () => {
    const names = providerDisplayNames(
      snapshotOf([{ slug: 'Google-Vertex', displayName: 'Google Vertex' }])
    );

    expect(names).toEqual([{ slug: 'google-vertex', displayName: 'Google Vertex' }]);
  });

  it('drops the suffix after a slash, as endpoint tags carry a quantization there', () => {
    const names = providerDisplayNames(
      snapshotOf([{ slug: 'deepinfra/turbo', displayName: 'DeepInfra' }])
    );

    expect(names).toEqual([{ slug: 'deepinfra', displayName: 'DeepInfra' }]);
  });

  it('keeps the first display name when two providers normalize to one slug', () => {
    const names = providerDisplayNames(
      snapshotOf([
        { slug: 'deepinfra', displayName: 'DeepInfra' },
        { slug: 'DeepInfra/turbo', displayName: 'DeepInfra Turbo' },
      ])
    );

    expect(names).toEqual([{ slug: 'deepinfra', displayName: 'DeepInfra' }]);
  });

  it('orders the result by slug so the response does not depend on snapshot order', () => {
    const names = providerDisplayNames(
      snapshotOf([
        { slug: 'z-ai', displayName: 'Z.ai' },
        { slug: 'anthropic', displayName: 'Anthropic' },
        { slug: 'moonshotai/turbo', displayName: 'Moonshot AI' },
      ])
    );

    expect(names.map(name => name.slug)).toEqual(['anthropic', 'moonshotai', 'z-ai']);
  });
});
