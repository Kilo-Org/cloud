import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type CreateBriefingState } from '@/lib/hooks/use-create-briefing';
import { draft, prepared } from '@/lib/hooks/use-create-briefing-test-utils';
import { act, TestRenderer } from '@/test/renderer';

import { BriefingPreparationScreen } from './briefing-preparation-screen';

const state = vi.hoisted(() => ({
  draft: null as CreateBriefingState['draft'],
  prepared: null as CreateBriefingState['prepared'],
  error: null as string | null,
  refresh: vi.fn(),
  dismissTo: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ 'report-id': 'report-1' }),
  useRouter: () => ({ dismissTo: state.dismissTo, replace: state.replace }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('./briefing-create-review', () => ({ BriefingCreateReview: 'BriefingCreateReview' }));
vi.mock('./briefing-window', () => ({ formatBriefingTimestamp: (value: string) => value }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-create-briefing', () => ({
  useCreateBriefing: () => ({ ...state, loading: false, preparing: false, creating: false }),
}));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/agent-briefing',
  useBriefingAccess: () => ({ canRead: () => true }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
beforeEach(() => {
  state.draft = { ...draft, status: 'ready' };
  state.prepared = prepared;
  state.error = null;
  state.refresh.mockReset();
  state.dismissTo.mockReset();
  state.replace.mockReset();
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
});
function mount() {
  act(() => {
    renderer = TestRenderer.create(createElement(BriefingPreparationScreen));
  });
}
function component(name: string) {
  const node = renderer?.root.find(item => (item.type as string) === name);
  if (!node) {
    throw new Error(`Missing component: ${name}`);
  }
  return node;
}

it('opens the create form when another review is requested', () => {
  mount();
  const review = component('BriefingCreateReview').props as { onReviewAgain: () => void };
  act(() => {
    review.onReviewAgain();
  });
  expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith('/agent-briefing/create');
  expect(state.refresh).not.toHaveBeenCalled();
});

it('refreshes the persisted draft when loading its estimate fails', () => {
  state.prepared = null;
  state.error = 'agentBriefing.reviewFailed';
  mount();
  const error = component('QueryError').props as { onRetry: () => void };
  act(() => {
    error.onRetry();
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.dismissTo).not.toHaveBeenCalled();
});

it('opens the published report when its preparation link is resumed', () => {
  state.prepared = {
    ...prepared,
    report: { ...prepared.report, publishedAt: draft.endAt },
  };
  mount();
  expect(state.replace).toHaveBeenCalledExactlyOnceWith(`/agent-briefing/${draft.id}`);
  expect(state.dismissTo).not.toHaveBeenCalled();
});
