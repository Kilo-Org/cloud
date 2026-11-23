import {
  customRouterEntryKey,
  type CustomRouterDefinition,
  type CustomRouterEntry,
} from '@kilocode/auto-routing-contracts';
import { customRouterPoolVersion } from '@/lib/auto-routing-custom-routers';

const SONNET = 'anthropic/claude-sonnet-4';
const FLASH = 'google/gemini-2.5-flash';
const ALIAS = '~vendor/latest';

function clientEntry(variants: string[] = ['think']): CustomRouterEntry {
  return {
    kind: 'client',
    provider: 'ollama',
    model: 'qwen3:8b',
    variants,
    capabilities: {
      contextLength: 32_000,
      inputModalities: ['text'],
      toolCall: true,
      reasoning: false,
    },
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
  };
}

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
      {
        kind: 'client',
        provider: 'ollama',
        model: 'qwen3:8b',
        variants: ['think'],
        capabilities: {
          contextLength: 32_000,
          inputModalities: ['text'],
          toolCall: true,
          reasoning: false,
        },
        pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
      },
    ],
    defaultEntryKey: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
    ...overrides,
  };
}

describe('customRouterPoolVersion', () => {
  test('is deterministic and does not depend on entry order', () => {
    const ordered = definition();
    const reordered = definition({ entries: [...definition().entries].reverse() });

    expect(customRouterPoolVersion(ordered)).toBe(customRouterPoolVersion(definition()));
    expect(customRouterPoolVersion(reordered)).toBe(customRouterPoolVersion(ordered));
  });

  test('changes when the pool definition changes', () => {
    const base = customRouterPoolVersion(definition());

    expect(customRouterPoolVersion(definition({ baseRouter: 'frontier' }))).not.toBe(base);
    // Remove/restore is a definition change in both directions: removing changes the version, and
    // restoring the same entries returns to the identity that body of cases was measured for.
    expect(
      customRouterPoolVersion(definition({ entries: definition().entries.slice(0, 1) }))
    ).not.toBe(base);
    expect(
      customRouterPoolVersion(
        definition({ defaultEntryKey: customRouterEntryKey({ kind: 'gateway', model: FLASH }) })
      )
    ).not.toBe(base);
  });

  test('changes when an entry link changes', () => {
    const unlinked = customRouterPoolVersion(definition());
    const linked = customRouterPoolVersion(
      definition({
        entries: [
          { kind: 'gateway', model: SONNET, measuredAs: FLASH },
          ...definition().entries.slice(1),
        ],
      })
    );

    expect(linked).not.toBe(unlinked);
  });

  test('tracks a concrete alias target change, because it changes the measured model', () => {
    const before = customRouterPoolVersion(
      definition({ entries: [{ kind: 'gateway', model: ALIAS }, ...definition().entries.slice(1)] })
    );
    const after = customRouterPoolVersion(
      definition({
        entries: [
          // The saved row holds the concrete target once an alias has been pinned or re-registered.
          { kind: 'gateway', model: 'vendor/concrete' },
          ...definition().entries.slice(1),
        ],
      })
    );

    expect(after).not.toBe(before);
  });

  test('ignores a serving pin and a refreshed client registration', () => {
    const base = customRouterPoolVersion(definition());

    expect(
      customRouterPoolVersion(
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
            ...definition().entries.slice(1),
          ],
        })
      )
    ).toBe(base);

    // A re-registration refreshes capabilities and pricing but selects the same cases.
    const refreshed: CustomRouterEntry = {
      kind: 'client',
      provider: 'ollama',
      model: 'qwen3:8b',
      variants: ['think'],
      capabilities: {
        contextLength: 128_000,
        inputModalities: ['text'],
        toolCall: true,
        reasoning: true,
      },
      pricing: { inputPerMTokUsd: 9, outputPerMTokUsd: 9 },
    };
    expect(
      customRouterPoolVersion(definition({ entries: [definition().entries[0]!, refreshed] }))
    ).toBe(base);
  });

  test('identity ignores a pin and refreshed client registration but moves on a concrete change', () => {
    const base = customRouterPoolVersion(definition());
    const pinned = definition({
      entries: [
        {
          kind: 'gateway',
          model: SONNET,
          servingPin: {
            model: 'vendor/other',
            pinnedAt: '2026-11-20T12:00:00.000Z',
            confirmedAt: '2026-11-20T11:00:00.000Z',
          },
        },
        definition().entries[1]!,
      ],
    });
    expect(customRouterPoolVersion(pinned)).toBe(base);

    expect(
      customRouterPoolVersion(
        definition({
          entries: [definition().entries[0]!, clientEntry(['fast'])],
        })
      )
    ).not.toBe(base);

    expect(
      customRouterPoolVersion(
        definition({ entries: [{ kind: 'gateway', model: 'vendor/concrete' }] })
      )
    ).not.toBe(base);
  });

  test('a true client link change always moves the version', () => {
    const gatewayEntry = definition().entries[0]!;
    const unlinked = customRouterPoolVersion(
      definition({ entries: [gatewayEntry, clientEntry()] })
    );
    const gained = customRouterPoolVersion(
      definition({ entries: [gatewayEntry, { ...clientEntry(), measuredAs: SONNET }] })
    );
    const moved = customRouterPoolVersion(
      definition({ entries: [gatewayEntry, { ...clientEntry(), measuredAs: FLASH }] })
    );

    expect(new Set([unlinked, gained, moved]).size).toBe(3);
  });

  test('changes when a client entry adds a variant, because that adds cases', () => {
    const base = customRouterPoolVersion(definition());
    const variantAdded = customRouterPoolVersion(
      definition({ entries: [definition().entries[0]!, clientEntry(['think', 'fast'])] })
    );

    expect(variantAdded).not.toBe(base);
  });
});
