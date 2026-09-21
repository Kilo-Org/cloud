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

/**
 * The card hands the store-management helper the invalidation to run after the
 * store trip. The helper runs it in a floating promise, so the test keeps the
 * callback here and awaits it itself: a missing query client filter then fails
 * the test instead of becoming an unhandled rejection.
 */
const storeManagement = vi.hoisted(() => ({
  invalidateAfter: undefined as (() => Promise<void> | void) | undefined,
}));

/** Every invalidation the card asks the query client to run. */
const invalidateQueries = vi.hoisted(() => vi.fn());

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

vi.mock('./kilo-pass-ios-manage', () => ({
  openAppStoreManagement: (params: { invalidateAfter: () => Promise<void> | void }) => {
    storeManagement.invalidateAfter = params.invalidateAfter;
  },
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
  storeManagement.invalidateAfter = undefined;
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
  it('invalidates the credit blocks after the store-management trip', async () => {
    cardState.content = {
      kind: 'card',
      state: {
        title: 'Kilo Pass',
        description: 'Monthly credits with bonus progress.',
        action: 'open-store-management',
        actionLabel: 'Manage',
      },
    };
    const root = renderCard();
    const card = root.findByProps({ accessibilityRole: 'button' });

    // The handler imports the helper lazily, so the capture lands a microtask
    // after the press.
    await act(async () => {
      (card.props.onPress as () => void)();
      await Promise.resolve();
    });
    const invalidateAfter = storeManagement.invalidateAfter;
    if (!invalidateAfter) {
      throw new Error('The store-management helper never received an invalidation');
    }

    await act(async () => {
      await invalidateAfter();
    });
    expect(invalidateQueries).toHaveBeenCalledWith(['user', 'getCreditBlocks']);
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
