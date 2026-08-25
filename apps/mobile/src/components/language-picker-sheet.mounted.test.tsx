/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
/* eslint-disable max-lines -- the apply and back-handler suites share one mock harness in this file */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { toast } from 'sonner-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { LanguagePickerSheet } from '@/components/language-picker-sheet';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const reloadAppAsync = vi.hoisted(() => vi.fn());
const setLanguagePreferenceAsync = vi.hoisted(() => vi.fn());
const writeLanguageReturnTarget = vi.hoisted(() => vi.fn());
const renameAndroidNotificationChannels = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
const insets = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const keyboard = vi.hoisted(() => {
  const listeners = new Map<string, (event?: { endCoordinates: { height: number } }) => void>();
  return {
    listeners,
    addListener: vi.fn(
      (event: string, listener: (event?: { endCoordinates: { height: number } }) => void) => {
        listeners.set(event, listener);
        return { remove: vi.fn(() => listeners.delete(event)) };
      }
    ),
  };
});
const i18nManager = vi.hoisted(() => ({
  allowRTL: vi.fn(),
  isRTL: false,
  forceRTL: vi.fn(),
}));
// FlatList renders through a callback, so a host-string mock would drop every
// row. This mock calls the render props so the row assertions still see rows.
const flatListMock = vi.hoisted(
  () =>
    ({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: readonly { tag: string }[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      keyExtractor: (item: { tag: string }) => string;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
    }) => {
      const rows = data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))
      );
      const empty = data.length === 0 ? ListEmptyComponent : null;
      return createElement('FlatList', null, ListHeaderComponent, ...rows, empty);
    }
);
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  FlatList: flatListMock,
  Keyboard: keyboard,
  Modal: 'Modal',
  Platform: platform,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  I18nManager: i18nManager,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  SlideInDown: { duration: vi.fn() },
  SlideOutDown: { duration: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@rn-primitives/portal', () => ({ Portal: 'Portal' }));
vi.mock('expo', () => ({ reloadAppAsync }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6b7280' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getLanguagePreference: () => 'device',
  getResolvedLanguage: () => 'en',
  setLanguagePreferenceAsync,
}));
vi.mock('@/i18n/resolve-language', () => ({
  resolveDeviceLanguage: () => 'en',
}));
vi.mock('@/i18n/return-target', () => ({
  writeLanguageReturnTarget,
}));
vi.mock('@/lib/notifications', () => ({
  renameAndroidNotificationChannels,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findChoiceRow(
  root: TestRenderer.ReactTestInstance,
  endonym: string
): TestRenderer.ReactTestInstance {
  const rows = findByType(root, 'ChoiceRow');
  for (const row of rows) {
    const label = row.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === endonym
    );
    if (label.length > 0) {
      return row;
    }
  }
  throw new Error(`ChoiceRow for ${endonym} not found`);
}

async function mountSheet(
  onClose: () => void,
  beforeReload?: () => Promise<void>
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(LanguagePickerSheet, {
        visible: true,
        onClose,
        returnTarget: 'login',
        beforeReload,
      })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function applySelection(
  onClose: () => void,
  endonym: string,
  beforeReload?: () => Promise<void>
): Promise<TestRenderer.ReactTestRenderer> {
  const renderer = await mountSheet(onClose, beforeReload);
  act(() => {
    (findChoiceRow(renderer.root, endonym).props.onPress as () => void)();
  });
  const sheet = findByType(renderer.root, 'PickerSheet')[0];
  if (!sheet) {
    throw new Error('PickerSheet not found');
  }
  await act(async () => {
    (sheet.props.onDone as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LanguagePickerSheet apply', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setLanguagePreferenceAsync.mockReset();
    setLanguagePreferenceAsync.mockResolvedValue(true);
    reloadAppAsync.mockReset();
    writeLanguageReturnTarget.mockReset();
    platform.OS = 'android';
    insets.bottom = 0;
    keyboard.listeners.clear();
    keyboard.addListener.mockClear();
    i18nManager.isRTL = false;
    i18nManager.forceRTL.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps the Android sheet above the keyboard and navigation inset', async () => {
    insets.bottom = 24;
    const renderer = await mountSheet(vi.fn<() => void>());
    const overlay = findByType(renderer.root, 'View').find(
      node => node.props.className === 'flex-1 justify-end bg-black/40'
    );
    if (!overlay) {
      throw new Error('keyboard-aware sheet overlay not found');
    }

    expect(overlay.props.style).toEqual([undefined, { paddingBottom: 0 }]);
    expect(keyboard.addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));

    act(() => {
      keyboard.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 240 } });
    });
    expect(overlay.props.style).toEqual([undefined, { paddingBottom: 264 }]);

    act(() => {
      keyboard.listeners.get('keyboardDidHide')?.();
    });
    expect(overlay.props.style).toEqual([undefined, { paddingBottom: 0 }]);

    renderer.unmount();
  });

  it('keeps the iOS sheet above the keyboard without adding its safe-area inset', async () => {
    platform.OS = 'ios';
    insets.bottom = 24;
    const renderer = await mountSheet(vi.fn<() => void>());
    const overlay = findByType(renderer.root, 'View').find(
      node => node.props.className === 'flex-1 justify-end bg-black/40'
    );
    if (!overlay) {
      throw new Error('keyboard-aware sheet overlay not found');
    }

    expect(keyboard.addListener).toHaveBeenCalledWith('keyboardWillShow', expect.any(Function));

    act(() => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 240 } });
    });
    expect(overlay.props.style).toEqual([undefined, { paddingBottom: 240 }]);

    renderer.unmount();
  });

  it('shows the standard empty state when the search matches no languages', async () => {
    const renderer = await mountSheet(vi.fn<() => void>());
    const input = findByType(renderer.root, 'TextInput')[0];
    if (!input) {
      throw new Error('language search input not found');
    }

    act(() => {
      (input.props.onChangeText as (value: string) => void)('zzzzzz');
    });

    const emptyState = findByType(renderer.root, 'EmptyState')[0];
    expect(emptyState?.props).toMatchObject({
      icon: 'SearchX',
      placement: 'top',
      title: 'No languages match',
      description: 'Try a different search term.',
    });
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);

    act(() => {
      (input.props.onChangeText as (value: string) => void)('');
    });
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(0);

    renderer.unmount();
  });

  it('applies an LTR language in place without reloading the app', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'Español');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('es', 'en');
    expect(i18n.language).toBe('es');
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(i18nManager.forceRTL).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps the current language and direction when the persist write fails', async () => {
    setLanguagePreferenceAsync.mockResolvedValue(false);
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(i18n.language).toBe('en');
    expect(i18nManager.isRTL).toBe(false);
    expect(i18nManager.forceRTL).not.toHaveBeenCalled();
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('keeps the current language and shows Retry when the catalog load fails', async () => {
    const changeLanguageSpy = vi
      .spyOn(i18n, 'changeLanguage')
      .mockRejectedValueOnce(new Error('missing catalog'));
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'Español');

    expect(setLanguagePreferenceAsync).not.toHaveBeenCalled();
    expect(i18n.language).toBe('en');
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not load the language. Please try again.');

    changeLanguageSpy.mockRestore();
    renderer.unmount();
  });

  it('shows Could not restart and Retry works when the RTL reload fails', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    const failedSheet = findByType(renderer.root, 'PickerSheet')[0];
    if (!failedSheet) {
      throw new Error('PickerSheet not found');
    }
    expect(failedSheet.props.title).toBe('Could not restart');
    expect(failedSheet.props.disabled).toBe(false);

    await act(async () => {
      (failedSheet.props.onDone as () => void)();
      await Promise.resolve();
    });
    expect(reloadAppAsync).toHaveBeenCalledTimes(2);

    renderer.unmount();
  });

  it('lets Android back cancel the sheet when idle', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet(onClose);

    const modal = findByType(renderer.root, 'Modal')[0];
    if (!modal) {
      throw new Error('Modal not found');
    }
    act(() => {
      (modal.props.onRequestClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps the back handler registered across an onClose identity change', async () => {
    const onCloseFirst = vi.fn<() => void>();
    const renderer = await mountSheet(onCloseFirst);

    const onCloseSecond = vi.fn<() => void>();
    await act(async () => {
      renderer.update(
        createElement(LanguagePickerSheet, {
          visible: true,
          onClose: onCloseSecond,
          returnTarget: 'login',
        })
      );
      await Promise.resolve();
    });

    const modal = findByType(renderer.root, 'Modal')[0];
    if (!modal) {
      throw new Error('Modal not found');
    }
    act(() => {
      (modal.props.onRequestClose as () => void)();
    });
    expect(onCloseFirst).not.toHaveBeenCalled();
    expect(onCloseSecond).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps Retry as the only action when the reload fails', async () => {
    reloadAppAsync.mockRejectedValue(new Error('reload failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية');

    const failedSheet = findByType(renderer.root, 'PickerSheet')[0];
    if (!failedSheet) {
      throw new Error('PickerSheet not found');
    }
    expect(failedSheet.props.onCancel).toBeUndefined();

    const backdrop = findByType(renderer.root, 'Pressable').find(
      node => node.props.accessibilityLabel === 'Cancel'
    );
    if (!backdrop) {
      throw new Error('backdrop Pressable not found');
    }
    act(() => {
      (backdrop.props.onPress as () => void)();
    });
    expect(onClose).not.toHaveBeenCalled();

    const modal = findByType(renderer.root, 'Modal')[0];
    if (!modal) {
      throw new Error('Modal not found');
    }
    act(() => {
      (modal.props.onRequestClose as () => void)();
    });
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('still reloads into RTL when the return-target write fails', async () => {
    writeLanguageReturnTarget.mockRejectedValue(new Error('write failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(writeLanguageReturnTarget).toHaveBeenCalledWith('login');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not block the RTL reload when the draft flush fails', async () => {
    const beforeReload = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('flush failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية', beforeReload);

    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('applies a same-direction RTL language in place without reloading', async () => {
    i18nManager.isRTL = true;
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'العربية');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar', 'en');
    expect(i18n.language).toBe('ar');
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(i18nManager.forceRTL).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('reloads into LTR when the direction changes from RTL', async () => {
    i18nManager.isRTL = true;
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'Español');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('es');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(i18nManager.forceRTL).toHaveBeenCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();
    // The restarting screen stays up while the reload is pending.
    expect(findByType(renderer.root, 'ActivityIndicator')).toHaveLength(1);

    renderer.unmount();
  });

  it('rolls the copy back when the persist write fails after the catalog loads', async () => {
    setLanguagePreferenceAsync.mockResolvedValue(false);
    const onClose = vi.fn<() => void>();
    const renderer = await applySelection(onClose, 'Español');

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('es', 'en');
    expect(i18n.language).toBe('en');
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
