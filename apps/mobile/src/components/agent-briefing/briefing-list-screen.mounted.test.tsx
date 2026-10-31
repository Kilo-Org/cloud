import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ElementType, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

import { BriefingListScreen } from './briefing-list-screen';

const requests = vi.hoisted(() => ({
  list: vi.fn<() => Promise<{ reports: never[]; nextCursor: null }>>(),
  push: vi.fn(),
}));
const queryKey = ['briefing-list'];

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    ListEmptyComponent,
    ...props
  }: {
    data: readonly unknown[];
    ListEmptyComponent: ReactElement;
  }) => createElement('FlashList', props, props.data.length === 0 ? ListEmptyComponent : null),
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: requests.push }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: ({ headerRight }: { headerRight?: ReactElement }) =>
    createElement('ScreenHeader', null, headerRight),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./briefing-card', () => ({ BriefingScorecard: 'BriefingScorecard' }));
vi.mock('./briefing-filter-controls', () => ({ BriefingFilterControls: 'BriefingFilterControls' }));
vi.mock('./briefing-period-label', () => ({ BriefingPeriodLabel: 'BriefingPeriodLabel' }));
vi.mock('@/lib/agent-briefing', () => ({
  BRIEFING_PATH: '/(app)/agent-briefing',
  useBriefingAccess: () => ({ enabled: true, canRead: () => true }),
  useBriefingDismissals: () => ({ data: [] }),
  useBriefingInvalidation: vi.fn(),
  useBriefingPreferences: () => ({
    data: { contexts: [{ context: { organizationId: null }, enabled: false }] },
  }),
}));
vi.mock('@/lib/hooks/use-briefing-list-filters', () => ({
  useBriefingListFilters: () => ({ history: false, organizationId: undefined }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ useOfflineBannerState: () => false }));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({ data: [] }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentBriefing: {
      list: {
        infiniteQueryOptions: () => ({
          queryKey: ['briefing-list'],
          queryFn: requests.list,
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
        }),
      },
    },
  }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let client: QueryClient | undefined = undefined;

function pressSettings(root: ReactTestInstance): void {
  const [button] = root.findAllByType('Button' as ElementType);
  if (!button) {
    throw new Error('Briefing settings control is missing');
  }
  // The Button stub keeps the caller's onPress; the renderer exposes props untyped.
  const props: { onPress: () => void } = button.props as { onPress: () => void };
  act(() => {
    props.onPress();
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  client?.clear();
  renderer = undefined;
  client = undefined;
  requests.list.mockReset();
  requests.push.mockReset();
  vi.useRealTimers();
});

it('keeps background updates silent and shows progress only for a pull until it finishes', async () => {
  const page = { reports: [], nextCursor: null };
  const background = Promise.withResolvers<typeof page>();
  const pull = Promise.withResolvers<typeof page>();
  requests.list.mockReturnValueOnce(background.promise).mockReturnValueOnce(pull.promise);
  vi.useFakeTimers();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client = queryClient;
  queryClient.setQueryData(queryKey, { pages: [page], pageParams: [undefined] });
  act(() => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(BriefingListScreen))
    );
  });
  const mounted = renderer;
  if (!mounted) {
    throw new Error('Briefing list did not mount');
  }
  const list = () => mounted.root.findByType('FlashList' as ElementType);

  let backgroundRefresh: Promise<void> | undefined = undefined;
  act(() => {
    backgroundRefresh = queryClient.invalidateQueries({ queryKey });
  });
  await vi.waitFor(() => {
    expect(queryClient.isFetching({ queryKey })).toBe(1);
    expect(requests.list).toHaveBeenCalledTimes(1);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(list().props.refreshing).toBe(false);

  await act(async () => {
    background.resolve(page);
    await backgroundRefresh;
  });
  act(() => {
    (list().props.onRefresh as () => void)();
  });
  expect(list().props.refreshing).toBe(true);
  expect(queryClient.isFetching({ queryKey })).toBe(1);

  await act(async () => {
    pull.resolve(page);
    await pull.promise;
  });
  await vi.waitFor(() => {
    expect(list().props.refreshing).toBe(false);
  });
  expect(queryClient.isFetching({ queryKey })).toBe(0);
});

it('offers settings instead of claiming an empty activity window when no context is enabled', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client = queryClient;
  queryClient.setQueryData(queryKey, {
    pages: [{ reports: [], nextCursor: null }],
    pageParams: [undefined],
  });
  act(() => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(BriefingListScreen))
    );
  });
  const mounted = renderer;
  if (!mounted) {
    throw new Error('Briefing list did not mount');
  }
  const buttons = mounted.root.findAllByType('Button' as ElementType);
  expect(buttons).toHaveLength(1);
  pressSettings(mounted.root);
  expect(requests.push).toHaveBeenCalledWith('/(app)/agent-briefing/settings');
});

it('keeps the settings action in the header while the list has reports', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client = queryClient;
  queryClient.setQueryData(queryKey, {
    pages: [
      {
        reports: [
          {
            id: 'report-1',
            context: { id: 'personal', name: null, organizationId: null },
            dismissedAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  act(() => {
    renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(BriefingListScreen))
    );
  });
  const mounted = renderer;
  if (!mounted) {
    throw new Error('Briefing list did not mount');
  }
  const header = mounted.root.findByType('ScreenHeader' as ElementType);
  expect(header.findAllByType('Button' as ElementType)).toHaveLength(1);
  expect(mounted.root.findAllByType('Button' as ElementType)).toHaveLength(1);
  pressSettings(header);
  expect(requests.push).toHaveBeenCalledWith('/(app)/agent-briefing/settings');
});
