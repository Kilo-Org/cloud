import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { KiloPassSubscriptionCard } from './kilo-pass-subscription-card';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

const invalidateQueries = vi.hoisted(() => vi.fn());

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
      getMobileStoreProducts: {
        queryOptions: () => ({ queryKey: ['kiloPass', 'products'] as const }),
      },
      getState: {
        queryOptions: () => ({ queryKey: ['kiloPass', 'state'] as const }),
        pathFilter: () => ['kiloPass', 'state'] as const,
      },
      getCreditHistory: { pathFilter: () => ['kiloPass', 'history'] as const },
    },
    user: {
      getContextBalance: { pathFilter: () => ['user', 'getContextBalance'] as const },
      getCreditBlocks: { pathFilter: () => ['user', 'getCreditBlocks'] as const },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isError: false, isPending: true, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/lib/kilo-pass/subscription-card-state', () => ({
  getKiloPassSubscriptionCardContentState: () => cardState.content,
  getKiloPassSubscriptionCardAccessibility: (state: { title: string }) => ({
    accessibilityLabel: state.title,
    accessibilityHint: undefined,
  }),
}));

vi.mock('@/lib/kilo-pass/dev-storekit-refund', () => ({
  getDevStoreKitRefundAppleProductId: () => null,
}));

vi.mock('./kilo-pass-ios-manage', () => ({
  openAppStoreManagement: vi.fn(async (params: { invalidateAfter: () => Promise<void> }) => {
    await params.invalidateAfter();
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

/** The classes of the body row: the one View that holds the icon tile. */
function bodyRowClasses(root: TestRenderer.ReactTestInstance): string[] {
  const tile = root.find(
    node => Object.is(node.type, 'View') && String(node.props.className).includes('h-10 w-10')
  );
  const row = tile.parent;
  return String(row?.props.className ?? '').split(' ');
}

/** The classes of the body row when the tile is a Skeleton instead of the icon. */
function loadingRowClasses(root: TestRenderer.ReactTestInstance): string[] {
  const tile = root.find(node => String(node.props.className).includes('h-10 w-10'));
  return String(tile.parent?.props.className ?? '').split(' ');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  windowDims.width = 390;
  cardState.content = CARD_CONTENT;
  invalidateQueries.mockClear();
});

describe('KiloPassSubscriptionCard mounted layout', () => {
  it('keeps the icon tile, copy, and action label on one row at phone widths', () => {
    const classes = bodyRowClasses(renderCard());
    expect(classes).toContain('flex-row');
    expect(classes).not.toContain('justify-between');
  });

  it('stacks the icon tile above the copy in a narrow window', () => {
    // The 160 dp window of the e1 round left the fixed icon tile plus the
    // fixed Subscribe label wider than the card, so the flexible text block
    // collapsed to zero width and the wrapped copy stretched the card into an
    // empty slab (Profile, 2026-09-21). A narrow window must stack instead,
    // the same presentation ConfigureRow takes on these screens.
    windowDims.width = 160;
    const root = renderCard();
    const classes = bodyRowClasses(root);
    expect(classes).toContain('flex-row');
    expect(classes).toContain('justify-between');
    // The copy keeps the card's full width instead of collapsing.
    expect(
      String(
        root.find(
          node => Object.is(node.type, 'View') && String(node.props.className).includes('w-full')
        ).props.className
      )
    ).toContain('w-full');
  });

  it('keeps the card pressable with its action label after the narrow swap', () => {
    windowDims.width = 160;
    const root = renderCard();
    const card = root.findByProps({ accessibilityRole: 'button' });
    expect(card.props.accessibilityLabel).toBe('Kilo Pass');
    expect(
      root.findAll(node => Object.is(node.type, 'Text') && node.props.children === 'Subscribe')
    ).toHaveLength(1);
  });
});

describe('KiloPassSubscriptionCard store management', () => {
  it('invalidates every credit query the store-management path reads', async () => {
    // The card's invalidateKiloPassState reads four path filters. A mock that
    // omits one throws `Cannot read properties of undefined (reading
    // 'pathFilter')` as soon as a test presses an open-store-management card
    // (review, PR 6481, 2026-09-21).
    cardState.content = {
      kind: 'card',
      state: {
        title: 'Kilo Pass',
        description: 'Manage your subscription.',
        action: 'open-store-management',
        actionLabel: 'Manage',
      },
    };
    const card = renderCard().findByProps({ accessibilityRole: 'button' });
    await act(async () => {
      (card.props.onPress as () => void)();
      await new Promise(resolve => {
        setImmediate(resolve);
      });
    });
    expect(invalidateQueries.mock.calls.map(([filter]) => filter)).toEqual([
      ['kiloPass', 'state'],
      ['user', 'getContextBalance'],
      ['user', 'getCreditBlocks'],
      ['kiloPass', 'history'],
    ]);
  });
});

describe('KiloPassSubscriptionCard loading layout', () => {
  it('stacks the skeleton in a narrow window and clamps both bars to the card', () => {
    cardState.content = { kind: 'loading' };
    windowDims.width = 160;
    const root = renderCard(false);
    // The skeleton keeps the same stacked shape as the content, so the swap
    // between them never reflows the card.
    expect(loadingRowClasses(root)).toContain('justify-between');
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
