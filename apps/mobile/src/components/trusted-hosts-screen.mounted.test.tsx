import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { TrustedHostsScreen } from '@/components/trusted-hosts-screen';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The Trusted hosts screen lives below Account (Preferences > Account > Trusted
 * hosts), so its empty-state action must not `back()` one level to Account while
 * it is labelled "Back to preferences". These cases pin the destination to the
 * Preferences hub the label names.
 */

const dismissTo = vi.hoisted(() => vi.fn());
const back = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ back, dismissTo }),
}));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  View: 'View',
}));
// Render the empty-state action so the button it carries is reachable; the real
// EmptyState needs a measured StateSurface this harness does not provide.
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', null, props.action),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Shield: 'Shield', X: 'X' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
  revokeHost: vi.fn(),
}));

const PREFERENCES_HREF = '/(app)/(tabs)/(3_profile)/preferences';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('TrustedHostsScreen empty state', () => {
  it('opens the Preferences hub from the button labelled "Back to preferences"', async () => {
    const { renderer, unmount } = await renderWithProviders(<TrustedHostsScreen />);

    const button = renderer.root.find(node => String(node.type) === 'Button');
    const text = renderer.root.find(node => String(node.type) === 'Text');
    expect(text.children).toEqual([i18n.t('trustedHosts.backToPreferences')]);

    (button.props.onPress as () => void)();

    expect(dismissTo).toHaveBeenCalledWith(PREFERENCES_HREF);
    expect(back).not.toHaveBeenCalled();
    unmount();
  });
});
