import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KiloPassSubscriptionCard } from './kilo-pass-subscription-card';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

type CardContent = {
  kind: string;
  state?: { title: string; description: string; action: string; actionLabel: string };
};

const cardState = vi.hoisted(() => {
  const card: CardContent = {
    kind: 'card',
    state: {
      title: 'Kilo Pass',
      description: 'Monthly credits with bonus progress.',
      action: 'open-web',
      actionLabel: 'Subscribe',
    },
  };
  return { content: card };
});

const CARD_CONTENT: CardContent = {
  kind: 'card',
  state: {
    title: 'Kilo Pass',
    description: 'Monthly credits with bonus progress.',
    action: 'open-web',
    actionLabel: 'Subscribe',
  },
};

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getPurchasePresentation: {
        queryOptions: () => ({ queryKey: ['kiloPass', 'presentation'] as const }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, isPending: true, refetch: vi.fn() }),
}));

vi.mock('@/lib/kilo-pass/subscription-card-state', () => ({
  getKiloPassSubscriptionCardContentState: () => cardState.content,
  getKiloPassSubscriptionCardAccessibility: (state: { title: string }) => ({
    accessibilityLabel: state.title,
    accessibilityHint: undefined,
  }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#fff' }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => windowDims,
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderCard(hideLoadingSkeleton = true) {
  act(() => {
    const element = createElement(KiloPassSubscriptionCard, { hideLoadingSkeleton });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KiloPassSubscriptionCard renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  windowDims.width = 390;
  cardState.content = CARD_CONTENT;
});

describe('KiloPassSubscriptionCard mounted layout', () => {
  it('keeps the card pressable with its action label in a narrow window', () => {
    // The 160 dp window of the e1 round left the fixed icon tile plus the
    // fixed Subscribe label wider than the card, so the flexible text block
    // collapsed to zero width and the wrapped copy stretched the card into an
    // empty slab (Profile, 2026-09-21). The card must stay one pressable with
    // its action label after the narrow swap.
    windowDims.width = 160;
    const root = renderCard();
    const cards = root.findAllByProps({ accessibilityRole: 'button' });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.props.accessibilityLabel).toBe('Kilo Pass');
    expect(
      root.findAll(node => Object.is(node.type, 'Text') && node.props.children === 'Subscribe')
    ).toHaveLength(1);
  });
});

describe('KiloPassSubscriptionCard loading layout', () => {
  it('clamps both loading bars to the narrow card', () => {
    cardState.content = { kind: 'loading' };
    windowDims.width = 160;
    const root = renderCard(false);
    const bars = root
      .findAll(
        node => Object.is(node.type, 'Skeleton') && /w-(28|48)/.test(String(node.props.className))
      )
      .map(node => String(node.props.className));
    expect(bars).toHaveLength(2);
    for (const className of bars) {
      expect(className).toContain('max-w-full');
    }
  });

  it('reserves the stacked card height while the balance skeleton owns the section', () => {
    cardState.content = { kind: 'loading' };
    windowDims.width = 160;
    const root = renderCard(true);
    expect(String(root.findByProps({ className: 'h-[114px]' }).props.className)).toBe('h-[114px]');
  });

  it('reserves the single-row card height at phone widths', () => {
    cardState.content = { kind: 'loading' };
    const root = renderCard(true);
    expect(String(root.findByProps({ className: 'h-[66px]' }).props.className)).toBe('h-[66px]');
  });
});
