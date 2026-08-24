/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
import { createElement } from 'react';
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
const i18nManager = vi.hoisted(() => ({
  allowRTL: vi.fn(),
  isRTL: false,
  forceRTL: vi.fn(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@rn-primitives/portal', () => ({ Portal: 'Portal' }));
vi.mock('expo', () => ({ reloadAppAsync }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LanguagePickerSheet apply', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setLanguagePreferenceAsync.mockReset();
    setLanguagePreferenceAsync.mockResolvedValue(true);
    reloadAppAsync.mockReset();
    writeLanguageReturnTarget.mockReset();
    i18nManager.isRTL = false;
    i18nManager.forceRTL.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('applies an LTR language in place without reloading the app', async () => {
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet(onClose);

    act(() => {
      (findChoiceRow(renderer.root, 'Español').props.onPress as () => void)();
    });

    const sheet = findByType(renderer.root, 'PickerSheet')[0];
    if (!sheet) {
      throw new Error('PickerSheet not found');
    }
    await act(async () => {
      (sheet.props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('es');
    expect(i18n.language).toBe('es');
    expect(reloadAppAsync).not.toHaveBeenCalled();
    expect(i18nManager.forceRTL).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps the current language and direction when the persist write fails', async () => {
    setLanguagePreferenceAsync.mockResolvedValue(false);
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet(onClose);

    act(() => {
      (findChoiceRow(renderer.root, 'العربية').props.onPress as () => void)();
    });

    const sheet = findByType(renderer.root, 'PickerSheet')[0];
    if (!sheet) {
      throw new Error('PickerSheet not found');
    }
    await act(async () => {
      (sheet.props.onDone as () => void)();
      await Promise.resolve();
    });

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
    const renderer = await mountSheet(onClose);

    act(() => {
      (findChoiceRow(renderer.root, 'Español').props.onPress as () => void)();
    });

    const sheet = findByType(renderer.root, 'PickerSheet')[0];
    if (!sheet) {
      throw new Error('PickerSheet not found');
    }
    await act(async () => {
      (sheet.props.onDone as () => void)();
      await Promise.resolve();
    });

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('es');
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
    const renderer = await mountSheet(onClose);

    act(() => {
      (findChoiceRow(renderer.root, 'العربية').props.onPress as () => void)();
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

  it('still reloads into RTL when the return-target write fails', async () => {
    writeLanguageReturnTarget.mockRejectedValue(new Error('write failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet(onClose);

    act(() => {
      (findChoiceRow(renderer.root, 'العربية').props.onPress as () => void)();
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

    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(writeLanguageReturnTarget).toHaveBeenCalledWith('login');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });

  it('does not block the RTL reload when the draft flush fails', async () => {
    const beforeReload = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('flush failed'));
    const onClose = vi.fn<() => void>();
    const renderer = await mountSheet(onClose, beforeReload);

    act(() => {
      (findChoiceRow(renderer.root, 'العربية').props.onPress as () => void)();
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

    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(setLanguagePreferenceAsync).toHaveBeenCalledWith('ar');
    expect(reloadAppAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    renderer.unmount();
  });
});
