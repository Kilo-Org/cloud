import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type CreateBriefingState } from '@/lib/hooks/use-create-briefing';
import { act, TestRenderer } from '@/test/renderer';

import { BriefingCreateScreen } from './briefing-create-screen';

const state = vi.hoisted(() => ({
  draft: null as CreateBriefingState['draft'],
  preparing: true,
  reset: vi.fn(),
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ context: 'personal' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('./briefing-drafts', () => ({ BriefingDrafts: 'BriefingDrafts' }));
vi.mock('./briefing-period-picker', () => ({ BriefingPeriodPicker: 'BriefingPeriodPicker' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ primary: '#000' }) }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-create-briefing', () => ({
  useCreateBriefing: () => ({ ...state, creating: false, error: null }),
}));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/agent-briefing',
  useBriefingAccess: () => ({ canRead: () => true }),
  useBriefingPreferences: () => ({
    isPending: false,
    data: {
      timezone: 'UTC',
      contexts: [
        { context: { id: 'personal', organizationId: null, name: 'Personal' } },
        { context: { id: 'org', organizationId: 'org', name: 'Organization' } },
      ],
    },
  }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
beforeEach(() => {
  state.draft = null;
  state.preparing = true;
  state.reset.mockClear();
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});
function mount() {
  act(() => {
    renderer = TestRenderer.create(createElement(BriefingCreateScreen));
  });
}
type ButtonState = {
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
  accessibilityState?: { selected?: boolean };
};
function button(label: string) {
  const node = renderer?.root
    .findAll(item => (item.type as string) === 'Button')
    .find(
      item =>
        item.findAll(child => (child.type as string) === 'Text' && child.props.children === label)
          .length > 0
    );
  if (!node) {
    throw new Error(`Missing action: ${label}`);
  }
  return { props: node.props as ButtonState };
}

it('keeps the form locked until the initial background request is acknowledged', () => {
  mount();
  expect(button('agentBriefing.last7Days').props.disabled).toBe(true);
  expect(button('Organization').props.disabled).toBe(true);
  expect(button('agentBriefing.reviewBriefing').props.loading).toBe(true);
});

it('allows another period and context while an accepted draft prepares in the background', () => {
  state.draft = {
    id: 'persisted-draft',
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    startAt: '2026-10-20T00:00:00Z',
    endAt: '2026-10-21T00:00:00Z',
    timezone: 'UTC',
    language: 'en',
    createdAt: '2026-10-21T00:00:00Z',
    status: 'running',
    error: null,
  };
  mount();
  expect(button('agentBriefing.last7Days').props.disabled).toBe(false);
  expect(button('Organization').props.disabled).toBe(false);
  expect(button('agentBriefing.reviewBriefing').props.loading).toBe(false);
  act(() => {
    button('agentBriefing.last7Days').props.onPress();
  });
  expect(button('agentBriefing.last7Days').props.accessibilityState?.selected).toBe(true);
  act(() => {
    button('Organization').props.onPress();
  });
  expect(button('Organization').props.accessibilityState?.selected).toBe(true);
});
