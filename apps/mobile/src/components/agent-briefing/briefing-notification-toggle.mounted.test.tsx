import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BriefingNotificationToggle } from './briefing-notification-toggle';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({}),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/agent-briefing', () => ({
  useBriefingPreferences: () => ({ data: { notificationsEnabled: false }, isError: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      updatePreferences: { mutationOptions: () => ({}) },
      preferences: { pathKey: () => ['agentBriefing', 'preferences'] },
    },
  }),
}));

function mount(showSettingsLink: boolean) {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingNotificationToggle, { showSettingsLink })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Notification settings are not mounted');
  }
  return mounted;
}

it('hides the device-notifications link when rendered on Notifications', () => {
  const mounted = mount(false);

  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(0);

  act(() => {
    mounted.unmount();
  });
});

it('shows the device-notifications link from Briefing settings', () => {
  const mounted = mount(true);

  expect(mounted.root.findAll(node => (node.type as string) === 'Button')).toHaveLength(1);

  act(() => {
    mounted.unmount();
  });
});
