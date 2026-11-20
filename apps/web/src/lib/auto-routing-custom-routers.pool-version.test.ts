import {
  customRouterEntryKey,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import { customRouterPoolVersion } from '@/lib/auto-routing-custom-routers';

const SONNET = 'anthropic/claude-sonnet-4';
const FLASH = 'google/gemini-2.5-flash';
const REVISION = '2026-11-20 12:00:00.000000+00';

function definition(overrides: Partial<CustomRouterDefinition> = {}): CustomRouterDefinition {
  return {
    id: '5f0f7f5e-0c6b-4f2e-9d63-1f0b3b0f1d11',
    ownerType: 'user',
    ownerId: 'user-1',
    slug: 'coding',
    name: 'Coding',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries: [
      { kind: 'gateway', model: SONNET },
      { kind: 'gateway', model: FLASH },
    ],
    defaultEntryKey: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
    ...overrides,
  };
}

describe('customRouterPoolVersion', () => {
  test('is deterministic and does not depend on entry order', () => {
    const ordered = definition();
    const reordered = definition({ entries: [...definition().entries].reverse() });

    expect(customRouterPoolVersion(ordered, REVISION)).toBe(
      customRouterPoolVersion(definition(), REVISION)
    );
    expect(customRouterPoolVersion(reordered, REVISION)).toBe(
      customRouterPoolVersion(ordered, REVISION)
    );
  });

  test('changes when the pool definition changes', () => {
    const base = customRouterPoolVersion(definition(), REVISION);

    expect(customRouterPoolVersion(definition({ baseRouter: 'frontier' }), REVISION)).not.toBe(
      base
    );
    expect(
      customRouterPoolVersion(definition({ entries: definition().entries.slice(0, 1) }), REVISION)
    ).not.toBe(base);
    expect(
      customRouterPoolVersion(
        definition({ defaultEntryKey: customRouterEntryKey({ kind: 'gateway', model: FLASH }) }),
        REVISION
      )
    ).not.toBe(base);
  });

  test('changes when an entry link changes', () => {
    const unlinked = customRouterPoolVersion(definition(), REVISION);
    const linked = customRouterPoolVersion(
      definition({
        entries: [
          { kind: 'gateway', model: SONNET, measuredAs: FLASH },
          { kind: 'gateway', model: FLASH },
        ],
      }),
      REVISION
    );

    expect(linked).not.toBe(unlinked);
  });

  test('advances with the edit revision, so a remove and restore still invalidates', () => {
    const before = customRouterPoolVersion(definition(), REVISION);

    expect(customRouterPoolVersion(definition(), '2026-11-20 12:00:00.000001+00')).not.toBe(before);
  });

  test('ignores a serving pin, so publishing one cannot invalidate a quote', () => {
    const unpinned = customRouterPoolVersion(definition(), REVISION);
    const pinned = customRouterPoolVersion(
      definition({
        entries: [
          {
            kind: 'gateway',
            model: SONNET,
            servingPin: {
              model: SONNET,
              pinnedAt: '2026-11-20T12:00:00.000Z',
              confirmedAt: '2026-11-20T11:00:00.000Z',
            },
          },
          { kind: 'gateway', model: FLASH },
        ],
      }),
      REVISION
    );

    expect(pinned).toBe(unpinned);
  });
});
