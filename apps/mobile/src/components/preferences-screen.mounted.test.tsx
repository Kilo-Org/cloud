import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PreferencesScreen } from '@/components/preferences-screen';
import { renderWithProviders } from '@/test/render-with-providers';

vi.hoisted(() => {
  vi.stubGlobal('__DEV__', false);
});
const push = vi.hoisted(() => vi.fn());
// The screen tree imports the development-only feature-flag section; that
// surface is covered in preferences-screen.feature-flags.mounted.test.tsx.
vi.mock('@/lib/analytics/posthog', () => ({
  useFeatureFlagStatuses: () => [],
}));
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Globe: 'Globe',
  Mic: 'Mic',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-preference', () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => ({ preference: 'system' }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountPreferences(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<PreferencesScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}
function hubRows(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
  );
}
function row(renderer: ReactTestRenderer, title: string): ReactTestInstance {
  const found = hubRows(renderer).find(item => item.props.title === title);
  if (!found) {
    throw new Error(`ConfigureRow for ${title} not found`);
  }
  return found;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  vi.resetAllMocks();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('PreferencesScreen hub', () => {
  it('renders one navigation row per settings group with its title and subtitle', async () => {
    const renderer = await mountPreferences();

    expect(hubRows(renderer)).toHaveLength(4);
    expect(row(renderer, 'General').props).toMatchObject({ icon: 'SlidersHorizontal', last: true });
    expect(row(renderer, 'Voice input').props).toMatchObject({
      icon: 'Mic',
      last: true,
      subtitle:
        "Transcribe voice input with a Kilo gateway model instead of the device's speech recognition. Your recording is sent to the Kilo gateway.",
    });
    expect(row(renderer, 'Account').props).toMatchObject({
      icon: 'Globe',
      last: true,
      subtitle: 'Language, trusted hosts, and device sessions',
    });
    expect(row(renderer, 'Notifications').props).toMatchObject({
      icon: 'Bell',
      subtitle: 'Push preferences',
      last: true,
    });
  });

  it.each([
    ['General', '/(app)/(tabs)/(3_profile)/general'],
    ['Voice input', '/(app)/(tabs)/(3_profile)/voice-input'],
    ['Account', '/(app)/(tabs)/(3_profile)/account'],
    ['Notifications', '/(app)/(tabs)/(3_profile)/notifications'],
  ])('pushes the %s subpage from its row', async (title, route) => {
    const renderer = await mountPreferences();

    act(() => {
      (row(renderer, title).props.onPress as () => void)();
    });

    expect(push).toHaveBeenCalledWith(route);
  });

  it('keeps the Appearance control with its three options', async () => {
    const renderer = await mountPreferences();

    const control = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'SegmentedControl'
    );
    expect(control).toHaveLength(1);
    expect(control[0]?.props.options).toEqual([
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ]);
    expect(control[0]?.props.value).toBe('system');
  });
});
