/* eslint-disable max-lines -- one focus harness drives every commit path the picker's sheet can take (blur, early Done, re-focus, re-registration) */
import { createElement, type EffectCallback, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelPickerContent } from '@/components/agents/model-picker-content';
import '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerBridge, type ModelPickerSelection } from '@/lib/picker-bridge';
import { modelPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

const routerBack = vi.hoisted(() => vi.fn());

// The route's focus lifecycle, driven by the test the way react-navigation
// drives the real one: the effect body runs when the route gains focus, its
// cleanup runs on blur, and an unmount cleans up only when the route was still
// focused. `focus()` re-runs the body, which is the re-focus a presented sheet
// can take while the person is still choosing.
const focusLifecycle = vi.hoisted(() => {
  const subscriptions = new Set<(focused: boolean) => void>();
  const lifecycle = {
    isFocused: true,
    subscribe(apply: (focused: boolean) => void): () => void {
      subscriptions.add(apply);
      return () => {
        subscriptions.delete(apply);
      };
    },
    blur(): void {
      lifecycle.isFocused = false;
      for (const apply of subscriptions) {
        apply(false);
      }
    },
    focus(): void {
      lifecycle.isFocused = true;
      for (const apply of subscriptions) {
        apply(true);
      }
    },
    reset(): void {
      lifecycle.isFocused = true;
      subscriptions.clear();
    },
  };
  return lifecycle;
});

vi.mock('expo-router', async () => {
  // `vi.mock` factories are hoisted above the file's imports, so a static
  // `useEffect` binding is not initialised when this factory runs: the dynamic
  // import is the module-loading boundary, not a runtime-selected specifier.
  const { useEffect } = await import('react');
  return {
    useRouter: () => ({ back: routerBack, push: vi.fn() }),
    useLocalSearchParams: () => ({}),
    useNavigation: () => ({ isFocused: () => focusLifecycle.isFocused }),
    // Mirrors expo-router's own useFocusEffect (expo-router/build/useFocusEffect):
    // one effect per (focused) run, cleanup on blur, and no second cleanup at
    // unmount once a blur already consumed it.
    useFocusEffect: (effect: EffectCallback) => {
      useEffect(() => {
        let cleanup: (() => void) | undefined = undefined;
        let isFocused = false;
        const run = () => {
          const destroy = effect();
          cleanup = typeof destroy === 'function' ? destroy : undefined;
        };
        const apply = (next: boolean) => {
          if (next === isFocused) {
            return;
          }
          isFocused = next;
          if (next) {
            run();
            return;
          }
          const destroy = cleanup;
          cleanup = undefined;
          destroy?.();
        };
        if (focusLifecycle.isFocused) {
          isFocused = true;
          run();
        }
        const unsubscribe = focusLifecycle.subscribe(apply);
        return () => {
          unsubscribe();
          if (cleanup !== undefined) {
            cleanup();
          }
        };
      }, [effect]);
    },
  };
});

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: { key: string }[];
    keyExtractor?: (item: { key: string }) => string;
    renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
  }) =>
    createElement(
      'FlashList',
      { ...props, ref: undefined },
      (props.data ?? []).map((item, index) =>
        createElement(
          'FlashListRow',
          { key: props.keyExtractor?.(item) ?? index },
          props.renderItem({ item, index })
        )
      )
    ),
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: {
    children?: ReactNode;
    headerContent?: ReactNode;
    onDone?: () => void;
    onCancel?: () => void;
    expired?: boolean;
  }) =>
    createElement(
      'PickerSheet',
      { onDone: props.onDone, onCancel: props.onCancel, expired: props.expired === true },
      props.headerContent,
      props.children
    ),
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Info: 'Info',
  Plus: 'Plus',
  Search: 'Search',
  SearchX: 'SearchX',
  X: 'X',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelPickerOptionRow: 'ModelPickerOptionRow',
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: [],
    favoritesError: null,
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#ffffff',
    mutedForeground: '#6b7280',
    foreground: '#111827',
    destructive: '#ef4444',
  }),
}));

/** The chat's stored model: the chip that must not still read it after a pick. */
const storedModel: SessionModelOption = {
  id: 'aion-labs/aion-3.5',
  name: 'Aion 3.5',
  displayId: 'aion-3.5',
  variants: [],
  isPreferred: true,
  provider: { id: 'aion-labs', name: 'Aion Labs' },
  showGatewayMetadata: false,
};

/**
 * The picked model. Two efforts keep the sheet open after the model tap, which
 * is the state every path here needs: a pick that is waiting for its close.
 */
const pickedModel: SessionModelOption = {
  id: 'deepseek/deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  displayId: 'deepseek-v4.1-flash',
  variants: ['', 'high'],
  isPreferred: false,
  provider: { id: 'deepseek', name: 'DeepSeek' },
  showGatewayMetadata: false,
};

function makeBridge(overrides: Partial<ModelPickerBridge> = {}): ModelPickerBridge {
  return {
    options: [storedModel, pickedModel],
    currentValue: storedModel.id,
    currentVariant: '',
    acceptsVariant: true,
    selectionScope: {
      sessionId: UNFENCED_ROUTE_KEY,
      ownerConnectionId: null,
      protocol: 'unknown',
      catalogGenerationIdentity: null,
    },
    isSelectionCurrent: () => true,
    onSelect: vi.fn<(selection: ModelPickerSelection) => void>(),
    ...overrides,
  };
}

/** Registers `bridge` in the slot the picker route reads, and returns it. */
function registerBridge(overrides: Partial<ModelPickerBridge> = {}): ModelPickerBridge {
  const bridge = makeBridge(overrides);
  modelPickerSlot.set(UNFENCED_ROUTE_KEY, bridge);
  return bridge;
}

async function mountPicker(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(ModelPickerContent));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('the model picker did not render');
  }
  return renderer;
}

/**
 * The sheet's own props, narrowed once here so each test reads the dismissal
 * callbacks and the expired state without repeating the index-signature casts.
 */
function sheet(renderer: TestRenderer.ReactTestRenderer): {
  expired: boolean;
  onDone: () => void;
  onCancel: () => void;
} {
  // `type` is an ElementType whose string arm tsc narrows to the intrinsic tags,
  // so the route's own component name needs the string view (the same trap the
  // picker's existing suites cast around).
  const node = renderer.root.findAll(
    candidate => typeof candidate.type === 'string' && (candidate.type as string) === 'PickerSheet'
  )[0];
  if (!node) {
    throw new Error('the picker sheet was not rendered');
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return {
    expired: node.props.expired === true,
    onDone: node.props.onDone as () => void,
    onCancel: node.props.onCancel as () => void,
  };
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The option a row host was rendered for; the row's props carry it through. */
function rowOption(node: TestRenderer.ReactTestInstance): SessionModelOption | undefined {
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return node.props.option as SessionModelOption | undefined;
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The row host the real row renders for `option`, with the press it performs. */
function row(renderer: TestRenderer.ReactTestRenderer, option: SessionModelOption) {
  const node = renderer.root
    .findAll(
      candidate =>
        typeof candidate.type === 'string' && (candidate.type as string) === 'ModelPickerOptionRow'
    )
    .find(candidate => rowOption(candidate)?.id === option.id);
  if (!node) {
    throw new Error(`the row for ${option.id} was not rendered`);
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return {
    selected: node.props.selected === true,
    onSelectModel: node.props.onSelectModel as (option: SessionModelOption) => void,
  };
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** The pick the person makes: a tap on a model row with several efforts. */
async function pick(
  renderer: TestRenderer.ReactTestRenderer,
  option: SessionModelOption
): Promise<void> {
  await act(async () => {
    row(renderer, option).onSelectModel(option);
    await Promise.resolve();
  });
}

function pressDone(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    sheet(renderer).onDone();
  });
}

function blur(): void {
  act(() => {
    focusLifecycle.blur();
  });
}

function refocus(): void {
  act(() => {
    focusLifecycle.focus();
  });
}

function unmount(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

describe('ModelPickerContent commit', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    routerBack.mockClear();
    modelPickerSlot.clearAll();
    focusLifecycle.reset();
  });

  afterEach(() => {
    modelPickerSlot.clearAll();
    focusLifecycle.reset();
  });

  // The ordinary iOS dismissal: Done pops the route (blur) and the unmount
  // follows. The pick must reach the caller exactly once, whichever of the two
  // the focus lifecycle reports first.
  it('commits the pick once when the dismissal blurs before the unmount', async () => {
    const bridge = registerBridge();
    const renderer = await mountPicker();

    await pick(renderer, pickedModel);
    pressDone(renderer);
    blur();
    unmount(renderer);

    expect(bridge.onSelect).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).toHaveBeenCalledWith({ option: pickedModel, variant: '' });
  });

  // A blur with the sheet still on screen (a presented surface above it, the
  // app returning to the foreground) is not a dismissal. The pick waits for
  // Done; the blur must not consume it.
  it('keeps a pick made before a blur until Done commits it', async () => {
    const bridge = registerBridge();
    const renderer = await mountPicker();

    await pick(renderer, pickedModel);
    blur();
    pressDone(renderer);
    unmount(renderer);

    expect(bridge.onSelect).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).toHaveBeenCalledWith({ option: pickedModel, variant: '' });
  });

  // Re-focus re-runs the route's focus effect. The person's pick is state the
  // sheet owns, not something the slot re-derives: it survives the re-focus,
  // stays the row's check, and still commits on Done.
  it('keeps a pick across a re-focus between the pick and Done', async () => {
    const bridge = registerBridge();
    const renderer = await mountPicker();

    await pick(renderer, pickedModel);
    blur();
    refocus();

    expect(sheet(renderer).expired).toBe(false);
    expect(row(renderer, pickedModel).selected).toBe(true);

    pressDone(renderer);
    unmount(renderer);

    expect(bridge.onSelect).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).toHaveBeenCalledWith({ option: pickedModel, variant: '' });
  });

  // The sheet opens before the caller has registered a bridge (a catalog that
  // has not loaded yet). Its Done closes an expired shell: nothing was picked,
  // so nothing is committed — not even after a bridge lands while it is open.
  it('takes no pick from a Done pressed before the bridge is ready', async () => {
    const renderer = await mountPicker();

    expect(sheet(renderer).expired).toBe(true);
    pressDone(renderer);
    expect(routerBack).toHaveBeenCalledTimes(1);

    const lateBridge = registerBridge();
    pressDone(renderer);
    unmount(renderer);

    expect(lateBridge.onSelect).not.toHaveBeenCalled();
  });

  // A composer that remounts while the sheet is open registers its bridge
  // again. That bridge holds the live caller's accept, so the pick goes there;
  // the bridge the sheet opened with would deliver it to a dead closure.
  it('delivers the pick to the bridge registered while the sheet is open', async () => {
    const staleBridge = registerBridge();
    const renderer = await mountPicker();

    await pick(renderer, pickedModel);
    const remountedBridge = registerBridge();
    pressDone(renderer);
    unmount(renderer);

    expect(remountedBridge.onSelect).toHaveBeenCalledTimes(1);
    expect(remountedBridge.onSelect).toHaveBeenCalledWith({ option: pickedModel, variant: '' });
    expect(staleBridge.onSelect).not.toHaveBeenCalled();
  });

  // Cancel stays a cancel: a pick waiting for its close is dropped, and the
  // caller keeps its model.
  it('drops a pending pick on Cancel', async () => {
    const bridge = registerBridge();
    const renderer = await mountPicker();

    await pick(renderer, pickedModel);
    act(() => {
      sheet(renderer).onCancel();
    });
    unmount(renderer);

    expect(routerBack).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).not.toHaveBeenCalled();
  });
});
