import { type ReactElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AccountSettingsScreen } from '@/components/account-settings-screen';
import { PreferencesScreen } from '@/components/preferences-screen';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The user-agent explorer filed "a screen has controls a screen reader cannot
 * announce" for settings-account and settings-preferences-dark: one clickable
 * focusable control per screen with no text and no content-desc anywhere in its
 * subtree (the explorer's `unlabeled_controls` scan). Its expectation is that
 * every control carries a text or content-desc label.
 *
 * These two screens are mounted for real here -- `ScreenHeader`, `ConfigureRow`
 * and the appearance `SegmentedControl` included, not stubbed -- and every
 * pressable control in the rendered tree is checked to announce something:
 * either its own `accessibilityLabel` or text somewhere below it, which is the
 * same tree rule the device scan applies. A control that announces nothing
 * fails the test. The non-empty-walk guards matter: a tree that stops rendering
 * controls must fail, not pass vacuously.
 */

vi.hoisted(() => {
  // The screens' import chain reaches expo modules that read `__DEV__` at
  // module scope; the app's own catalog is the English reference either way.
  vi.stubGlobal('__DEV__', false);
});

const push = vi.hoisted(() => vi.fn());
const back = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const canGoBack = vi.hoisted(() => vi.fn(() => true));

// Every theme token resolves to a color string; the real palette is not the
// subject here and `src/global.css` is not compiled in a node environment.
const themeColors = new Proxy(
  {},
  {
    get: () => '#000000',
  }
);

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push, back, replace, canGoBack }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Globe: 'Globe',
  KeyRound: 'KeyRound',
  Mic: 'Mic',
  Shield: 'Shield',
  SlidersHorizontal: 'SlidersHorizontal',
  Smartphone: 'Smartphone',
  WandSparkles: 'WandSparkles',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronLeft: 'DirectionalChevronLeft',
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The appearance control is mounted for real below, so its selection haptic is
// reached at import time; the node environment cannot load the native module.
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/offline-banner-space', () => ({ useOfflineBannerSpace: () => false }));
// The development-only flag surface pulls the Expo application module, which a
// node environment cannot load; it renders no control on these screens.
vi.mock('@/components/feature-flags-section', () => ({ FeatureFlagsSection: () => null }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => themeColors }));
vi.mock('@/lib/hooks/use-theme-preference', () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => ({ preference: 'system' }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));
vi.mock('@/lib/picker-bridge', () => ({ setLanguagePickerBridge: vi.fn() }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;

async function mount(screen: ReactElement): Promise<ReactTestRenderer> {
  view = await renderWithProviders(screen);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}

/**
 * Every pressable control in the tree. Rendered (host) nodes only: a
 * `ConfigureRow` composite element also carries an `onPress` prop, so matching
 * it as well counted every row twice and let a screen that dropped a row stay
 * above the per-screen floor below.
 */
function controls(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (Object.is(node.type, 'Pressable') ||
        node.props.accessibilityRole === 'button' ||
        typeof node.props.onPress === 'function')
  );
}

/** All text below a node, joined -- the tree scan accepts a labelled child. */
function subtreeText(node: ReactTestInstance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : subtreeText(child)))
    .join(' ');
}

function announcedBy(control: ReactTestInstance): string {
  const label = control.props.accessibilityLabel;
  if (typeof label === 'string' && label.trim() !== '') {
    return label;
  }
  return subtreeText(control).trim();
}

beforeEach(() => {
  vi.stubGlobal('__DEV__', false);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  canGoBack.mockReturnValue(true);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('settings screens announce every control', () => {
  it('labels the back control and every Account settings row', async () => {
    const renderer = await mount(<AccountSettingsScreen />);
    const found = controls(renderer.root);

    // Back, then the account rows (language, trusted hosts, passkeys, sessions).
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(
      found.map(control => announcedBy(control)).filter(label => label === i18n.t('common.goBack'))
    ).toHaveLength(1);

    for (const control of found) {
      expect(announcedBy(control)).not.toBe('');
    }
  });

  it('labels the back control, every Preferences row, and the appearance control', async () => {
    const renderer = await mount(<PreferencesScreen />);
    const found = controls(renderer.root);

    // Back, the five hub rows, and the three appearance options. The floor
    // matches that full count, so a screen that stops rendering a row fails
    // the walk instead of passing on a lower threshold.
    expect(found.length).toBeGreaterThanOrEqual(9);
    expect(
      found.map(control => announcedBy(control)).filter(label => label === i18n.t('common.goBack'))
    ).toHaveLength(1);

    for (const control of found) {
      expect(announcedBy(control)).not.toBe('');
    }

    // The appearance control is mounted for real: its group carries the visible
    // section name and every option announces its own label, so a screen reader
    // hears what each choice is.
    const appearanceGroup = renderer.root.findAll(
      node => node.props.accessibilityRole === 'radiogroup'
    );
    expect(appearanceGroup).toHaveLength(1);
    expect(appearanceGroup[0]?.props.accessibilityLabel).toBe(i18n.t('preferences.appearance'));

    const appearanceOptions = renderer.root.findAll(
      node => node.props.accessibilityRole === 'radio'
    );
    expect(appearanceOptions.map(option => announcedBy(option))).toEqual([
      i18n.t('preferences.appearanceSystem'),
      i18n.t('preferences.appearanceLight'),
      i18n.t('preferences.appearanceDark'),
    ]);
  });
});
