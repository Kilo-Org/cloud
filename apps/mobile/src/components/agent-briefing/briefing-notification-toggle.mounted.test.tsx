import { createElement, type FunctionComponent } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  BriefingNotificationCategoryRow,
  BriefingNotificationToggle,
} from './briefing-notification-toggle';

const mutate = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false }),
  useQueryClient: () => ({}),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Newspaper: 'Newspaper' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/agent-briefing', () => ({
  useBriefingPreferences: () => ({ data: { notificationsEnabled: false }, isError: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      updatePreferences: { mutationOptions: () => ({}) },
      preferences: { pathKey: () => ['agentBriefing', 'preferences'] },
    },
  }),
}));

function mount<P extends object>(component: FunctionComponent<P>, props: P) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(createElement(component, props));
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Notification settings are not mounted');
  }
  return mounted;
}

function switchOf(mounted: TestRenderer.ReactTestRenderer) {
  return mounted.root.find(node => (node.type as string) === 'Switch');
}

it('shows the device-notifications link from Briefing settings', () => {
  const mounted = mount(BriefingNotificationToggle, {});

  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(1);

  act(() => {
    mounted.unmount();
  });
});

it('saves the brief preference from its Notifications category row', () => {
  mutate.mockClear();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: false });

  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(0);
  act(() => {
    (switchOf(mounted).props.onValueChange as (value: boolean) => void)(true);
  });
  expect(mutate).toHaveBeenCalledWith({ notificationsEnabled: true });

  act(() => {
    mounted.unmount();
  });
});

it('disables the category row with the device-notification gate', () => {
  mutate.mockClear();
  const mounted = mount(BriefingNotificationCategoryRow, { disabled: true });

  expect(switchOf(mounted).props.disabled).toBe(true);
  act(() => {
    (switchOf(mounted).props.onValueChange as (value: boolean) => void)(true);
  });
  expect(mutate).not.toHaveBeenCalled();

  act(() => {
    mounted.unmount();
  });
});
