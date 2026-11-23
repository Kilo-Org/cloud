// Mounted cases for the price fixture's inline error tile. The fixture runs the
// real screen against a stand-in store that refuses any purchase the way a
// device without a billing client does, so the screen's clear-then-publish
// cycle is observable here without a store or a network.
import type * as ExpoIapErrorMapping from 'expo-iap/build/utils/errorMapping';
import type * as ExpoIapTypes from 'expo-iap/build/types';
import type * as SharedUtils from '@kilocode/app-shared/utils';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { CreditPackPricesFixture } from './credit-pack-prices-fixture';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
  Pressable: 'Pressable',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  useColorScheme: () => 'light',
  useWindowDimensions: () => ({ width: 411, height: 914, scale: 1, fontScale: 1 }),
}));

// `expo-iap`'s entry loads expo-modules-core, which no Node test has. The two
// pieces the fixture and its purchase path use are pure, so keep them real: the
// refusal shape the fixture throws is then the one the mapper reads on device.
vi.mock('expo-iap', async () => {
  const types = await vi.importActual<typeof ExpoIapTypes>('expo-iap/build/types');
  const mapping = await vi.importActual<typeof ExpoIapErrorMapping>(
    'expo-iap/build/utils/errorMapping'
  );
  return {
    ErrorCode: types.ErrorCode,
    createPurchaseError: mapping.createPurchaseError,
    // The native hooks and the store calls are never reached: the fixture
    // supplies its own store context and never mounts the real IAP owner.
    useIAP: vi.fn(),
    fetchProducts: vi.fn(),
  };
});

vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// The keychain is a native module; `@/lib/trpc` reads the stored token expiry
// through it. Nothing here signs in, so every read answers `null`.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
  // The write options the credential module builds at import time.
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
}));

vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/detail-screen', () => ({
  DetailScreenScrollView: 'DetailScreenScrollView',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  RotateCcw: 'RotateCcw',
  Wallet: 'Wallet',
}));
vi.mock('@sentry/react-native', () => ({ captureException: () => undefined }));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const hideBalancePref = vi.hoisted(() => ({ hideBalance: false, hasLoaded: true }));

vi.mock('@/lib/hooks/use-hide-balance-preference', () => ({
  useHideBalancePreference: () => ({
    hideBalance: hideBalancePref.hideBalance,
    hasLoaded: hideBalancePref.hasLoaded,
    setHideBalance: vi.fn(),
  }),
}));
vi.mock('@/lib/utils', async () => {
  const sharedUtils = await vi.importActual<typeof SharedUtils>('@kilocode/app-shared/utils');
  return {
    cn: (...args: unknown[]) => args.filter(arg => typeof arg === 'string').join(' '),
    parseTimestamp: sharedUtils.parseTimestamp,
  };
});
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: (select: (state: { height: number }) => unknown) => select({ height: 0 }),
}));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));

const CONNECTION_TILE = "Couldn't reach the App Store. Try again.";
const TIMEOUT_TILE = "App Store didn't respond in time. Try again.";

function textOf(instance: TestRenderer.ReactTestInstance): string {
  const texts: string[] = [];
  const walk = (node: TestRenderer.ReactTestInstance): void => {
    for (const child of node.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else if (typeof child === 'number') {
        texts.push(String(child));
      } else {
        walk(child);
      }
    }
  };
  walk(instance);
  return texts.join(' ');
}

function classNameOf(node: TestRenderer.ReactTestInstance): string {
  const props: unknown = node.props;
  if (typeof props !== 'object' || props === null || !('className' in props)) {
    return '';
  }
  const { className } = props;
  return typeof className === 'string' ? className : '';
}

function testIDOf(node: TestRenderer.ReactTestInstance): string {
  const props: unknown = node.props;
  if (typeof props !== 'object' || props === null || !('testID' in props)) {
    return '';
  }
  const { testID } = props;
  return typeof testID === 'string' ? testID : '';
}

/** The floating purchase error tile: the frame that carries the danger tint. */
function errorTileText(renderer: ReactTestRenderer): string {
  const tiles = renderer.root.findAll(node =>
    classNameOf(node).includes('border-danger-tile-border')
  );
  return tiles.map(tile => textOf(tile)).join(' | ');
}

function packRows(renderer: ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node => String(node.type) === 'Pressable' && testIDOf(node) === 'credit-pack-row'
  );
}

/** Press a row: the screen's handler calls `clearError()` and then the fixture `purchase`. */
function pressRow(node: TestRenderer.ReactTestInstance): void {
  const { onPress } = node.props as { onPress?: () => void };
  if (!onPress) {
    throw new Error('pressRow: node has no onPress');
  }
  onPress();
}

function delay(ms: number): Promise<void> {
  const answer = Promise.withResolvers<undefined>();
  setTimeout(answer.resolve, ms);
  return answer.promise;
}

/** Yield real timers so a settled query or the stand-in store can advance. */
async function flush(ms = 50): Promise<void> {
  await act(async () => {
    await delay(ms);
  });
}

async function waitUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially
    await flush();
  }
  if (!predicate()) {
    throw new Error('waitUntil: condition not met');
  }
}

type FixtureState = 'failed' | 'timed-out';

async function mountFixture(state: FixtureState): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(CreditPackPricesFixture, { state }));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('the fixture did not mount');
  }
  return renderer;
}

/** Switch the same mounted renderer to another state, as a link press does. */
async function showState(renderer: ReactTestRenderer, state: FixtureState): Promise<void> {
  await act(async () => {
    renderer.update(createElement(CreditPackPricesFixture, { state }));
    await Promise.resolve();
  });
}

async function tapFirstPack(renderer: ReactTestRenderer): Promise<void> {
  const firstPack = packRows(renderer)[0];
  if (!firstPack) {
    throw new Error('no pack row to press');
  }
  await act(async () => {
    pressRow(firstPack);
    await Promise.resolve();
  });
}

describe('CreditPackPricesFixture inline error tile', () => {
  it('empties the tile while a retried purchase is open and names the refusal after it', async () => {
    const tree = await mountFixture('failed');
    await waitUntil(() => packRows(tree).length === 4);
    expect(errorTileText(tree)).toBe(CONNECTION_TILE);

    await tapFirstPack(tree);
    expect(errorTileText(tree)).toBe('');

    await waitUntil(() => errorTileText(tree).includes(CONNECTION_TILE));
    expect(errorTileText(tree)).toBe(CONNECTION_TILE);
    expect(packRows(tree)).toHaveLength(4);

    tree.unmount();
  });

  it('keeps the refusal when another state presses a row it never charges for', async () => {
    const tree = await mountFixture('failed');
    await waitUntil(() => packRows(tree).length === 4);
    await tapFirstPack(tree);
    await waitUntil(() => errorTileText(tree).includes(CONNECTION_TILE));

    await showState(tree, 'timed-out');
    await waitUntil(() => errorTileText(tree).includes('respond in time'));
    expect(errorTileText(tree)).toBe(TIMEOUT_TILE);
    await tapFirstPack(tree);

    await showState(tree, 'failed');
    await flush(150);
    expect(errorTileText(tree)).toBe(CONNECTION_TILE);

    tree.unmount();
  });
});
