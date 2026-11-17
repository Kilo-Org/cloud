import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KiloPassSubscriptionCard } from './kilo-pass-subscription-card';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

type CardContent = {
  kind: string;
  title?: string;
  description?: string;
  accessibilityLabel?: string;
};

const cardState = vi.hoisted(() => {
  const card: CardContent = {
    kind: 'card',
    title: 'Kilo Pass',
    description: 'Active',
    accessibilityLabel: 'Kilo Pass. Active',
  };
  return { content: card };
});

const CARD_CONTENT: CardContent = {
  kind: 'card',
  title: 'Kilo Pass',
  description: 'Active',
  accessibilityLabel: 'Kilo Pass. Active',
};

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloPass: {
      getState: { queryOptions: () => ({ queryKey: ['kiloPass', 'getState'] as const }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, isPending: true, refetch: vi.fn() }),
}));

vi.mock('@/lib/kilo-pass/state', () => ({
  getKiloPassCardContentState: () => cardState.content,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#fff' }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useColorScheme: () => 'light',
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
  it('moves the copy below the tile row in a narrow window and keeps one pressable', () => {
    // A narrow window puts the copy on its own row below the icon tile row.
    windowDims.width = 160;
    const root = renderCard();
    // The host control only: `ConfigureRow` passes the role to `RowFrame`, so
    // matching by prop would count the composite and its Pressable twice.
    const cards = root.findAll(
      node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.props.accessibilityLabel).toBe('Kilo Pass. Active');

    const tileRow = root.find(node => Object.is(node.type, 'KiloPassIcon')).parent?.parent;
    expect(tileRow?.findAll(node => Object.is(node.type, 'Text'))).toHaveLength(0);
    expect(
      root.findAll(node => Object.is(node.type, 'Text') && node.props.children === 'Kilo Pass')
    ).toHaveLength(1);
  });
});

describe('KiloPassSubscriptionCard loading layout', () => {
  it('clamps the loading bars to the narrow card', () => {
    cardState.content = { kind: 'loading' };
    windowDims.width = 160;
    const root = renderCard(false);
    const bars = root
      .findAll(
        node =>
          Object.is(node.type, 'Skeleton') && String(node.props.className).includes('max-w-full')
      )
      .map(node => String(node.props.className));
    // The skeleton row is the shared row primitive: its title and subtitle bars
    // are the loading shape of the row the card settles into.
    expect(bars).toHaveLength(2);
  });

  it('keeps the loading row in the flow while the balance skeleton owns the section', () => {
    // The credits section shows its one loading indicator (the balance
    // skeleton), so the card paints no shimmer of its own; its row keeps the
    // space in the flow, invisible, so the sections below do not move when the
    // pass answer arrives.
    for (const width of [160, 390]) {
      cardState.content = { kind: 'loading' };
      windowDims.width = width;
      const root = renderCard(true);
      const hidden = root.findAll(
        node =>
          typeof node.props.className === 'string' && node.props.className.includes('opacity-0')
      );
      expect(hidden).toHaveLength(1);
      expect(hidden[0]?.findAll(node => Object.is(node.type, 'Skeleton')).length).toBeGreaterThan(
        0
      );
      expect(root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
    }
  });
});
