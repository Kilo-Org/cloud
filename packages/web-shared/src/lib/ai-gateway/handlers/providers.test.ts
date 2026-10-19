import { describe, expect, test } from '@jest/globals';
import { withDirectByokProviders } from '@kilocode/web-shared/lib/ai-gateway/handlers/providers';

function provider(slug: string, name: string) {
  return {
    name,
    displayName: name,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  };
}

describe('withDirectByokProviders', () => {
  test('adds direct BYOK providers missing from the snapshot, sorted by name', () => {
    expect(
      withDirectByokProviders(
        [provider('anthropic', 'Anthropic'), provider('z-ai', 'Z.AI')],
        [provider('synthetic', 'Synthetic'), provider('edenai', 'Eden AI')]
      ).map(entry => entry.slug)
    ).toEqual(['anthropic', 'edenai', 'synthetic', 'z-ai']);
  });

  test('keeps the snapshot entry when a slug is already listed', () => {
    const snapshotEntry = provider('synthetic', 'Synthetic (snapshot)');

    expect(withDirectByokProviders([snapshotEntry], [provider('synthetic', 'Synthetic')])).toEqual([
      snapshotEntry,
    ]);
  });

  test('includes the defined direct BYOK listings by default', () => {
    const slugs = withDirectByokProviders([]).map(entry => entry.slug);

    expect(slugs).toContain('synthetic');
    expect(slugs).not.toContain('zai-coding');
  });
});
