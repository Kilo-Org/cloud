/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PreferencesScreen } from '@/components/preferences-screen';

const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Brain: 'Brain',
  CornerDownLeft: 'CornerDownLeft',
  Globe: 'Globe',
  MessageSquare: 'MessageSquare',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
}));
vi.mock('@/components/language-picker-sheet', () => ({
  LanguagePickerSheet: 'LanguagePickerSheet',
}));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/picker-bridge', () => ({
  setLanguagePickerBridge,
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  useKeepScreenOnPreference: () => ({
    keepScreenOn: false,
    hasLoaded: true,
    setKeepScreenOn: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-pr-review-footer-preference', () => ({
  usePrReviewFooterPreference: () => ({
    prReviewFooter: true,
    hasLoaded: true,
    setPrReviewFooter: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({
  useReasoningPreference: () => ({
    defaultExpanded: false,
    hasLoaded: true,
    setDefaultExpanded: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-preference', () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => ({ preference: 'system' }),
}));
vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    returnSendsMessage: false,
    hasLoaded: true,
    setReturnSendsMessage: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ secondaryForeground: '#000000', mutedForeground: '#000000' }),
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));

async function mountPreferences(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(PreferencesScreen));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PreferencesScreen account rows', () => {
  it('renders the Language and Device sessions rows moved off the profile screen', async () => {
    const renderer = await mountPreferences();

    const rows = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
    );
    const language = rows.filter(row => row.props.title === 'Language');
    const deviceSessions = rows.filter(row => row.props.title === 'Device sessions');

    expect(language).toHaveLength(1);
    expect(language[0]?.props.icon).toBe('Globe');
    expect(language[0]?.props.subtitle).toBe('Device · English');
    expect(deviceSessions).toHaveLength(1);

    renderer.unmount();
  });

  it('language row opens the app language picker with returnTarget preferences', async () => {
    const renderer = await mountPreferences();

    const rows = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
    );
    const language = rows.find(row => row.props.title === 'Language');
    if (!language) {
      throw new Error('language row not found');
    }

    act(() => {
      (language.props.onPress as () => void)();
    });

    expect(push).toHaveBeenCalledWith('/(app)/language-picker');
    expect(setLanguagePickerBridge).toHaveBeenCalledTimes(1);
    expect(setLanguagePickerBridge).toHaveBeenCalledWith({
      onApplied: expect.any(Function),
    });

    renderer.unmount();
  });
});

describe('PreferencesScreen Return-sends switch', () => {
  it('renders the Return-sends switch off by default with its title and subtitle', async () => {
    const renderer = await mountPreferences();

    const switches = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Switch'
    );
    const returnSends = switches.find(
      sw => sw.props.accessibilityLabel === 'Return key sends message'
    );

    expect(returnSends).toBeDefined();
    expect(returnSends?.props.value).toBe(false);

    const texts = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    );
    expect(texts.some(t => t.props.children === 'Return key sends message')).toBe(true);
    expect(
      texts.some(t => t.props.children === 'When off, Return inserts a newline in agent composers.')
    ).toBe(true);

    renderer.unmount();
  });
});
