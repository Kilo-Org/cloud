import { DEFAULT_SECURITY_FINDING_FILTERS } from '@kilocode/app-shared/security-agent';
import { act, type ComponentProps, createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SecurityAgentFilterFindingsRoute from '@/app/(app)/(tabs)/(3_profile)/security-agent/[scope]/filter';
import { FlatList } from 'react-native';
import { Skeleton } from '@/components/ui/skeleton';
import { PickerSheet } from '@/components/picker-sheet';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { renderWithProviders } from '@/test/render-with-providers';
import { FindingListScreen } from './finding-list-screen';

type FindingPages = { pages: { findings: { id: string }[] }[] };
const findings = vi.hoisted(() => ({
  data: undefined as FindingPages | undefined,
  isLoading: false,
  isError: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  push: vi.fn(),
  bridge: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  FlatList: 'FlatList',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.push, back: vi.fn() }),
  useFocusEffect: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/components/ui/icons', () => ({
  ShieldCheck: 'ShieldCheck',
  SlidersHorizontal: 'SlidersHorizontal',
  Info: 'Info',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
vi.mock('@/components/security-agent/finding-filter-modal', () => ({
  FindingFilterModal: 'FindingFilterModal',
}));
vi.mock('@/components/security-agent/finding-row', () => ({ FindingRow: 'FindingRow' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentConfig: () => ({ data: { repositorySelectionMode: 'all' } }),
  useSecurityAgentRepositories: () => ({ data: [], isLoading: false, isError: false }),
  useSecurityAnalysisCapacity: () => ({ runningCount: 0, concurrencyLimit: 3 }),
}));
vi.mock('@/lib/hooks/use-security-findings', () => ({
  useSecurityFindings: (...args: unknown[]) => {
    mocks.query(...args);
    return findings;
  },
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/lib/security-finding-filter-bridge', () => ({
  setSecurityFindingFilterBridge: mocks.bridge,
}));
vi.mock('@/lib/route-registry', () => ({
  SECURITY_FILTER_ROUTE_KEY: 'security-filter',
  securityFilterSlot: { get: () => undefined },
  useRouteRegistry: vi.fn(),
}));

let mounted: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mount(routeParams: ComponentProps<typeof FindingListScreen>['routeParams'] = {}) {
  mounted = await renderWithProviders(
    <FindingListScreen scope="personal" routeParams={routeParams} />
  );
  return mounted.renderer.root;
}

async function refresh(control: ReactElement<{ onRefresh: () => void }>) {
  await act(async () => {
    control.props.onRefresh();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  findings.data = { pages: [{ findings: [] }] };
  findings.isLoading = false;
  findings.isError = false;
  findings.isFetchingNextPage = false;
  findings.isFetchNextPageError = false;
  findings.hasNextPage = false;
  findings.refetch.mockResolvedValue({ isError: false });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('Security Agent list surfaces', () => {
  it('centers an empty list outside the list with refresh and the header', async () => {
    const root = await mount();
    const empty = root.findByType(EmptyState);
    expect(empty.props.title).toBe('securityAgent.findingList.emptyTitle');
    expect(empty.props.placement).not.toBe('top');
    expect(root.findAllByType(FlatList)).toHaveLength(0);
    expect(root.findAllByType(ScreenHeader)).toHaveLength(1);
    await refresh(empty.props.refreshControl as ReactElement<{ onRefresh: () => void }>);
    expect(findings.refetch).toHaveBeenCalledOnce();
  });

  it('preserves Clear filters in the centered filtered state', async () => {
    const root = await mount({ severity: 'high' });
    const empty = root.findByType(EmptyState);
    expect(empty.props.title).toBe('securityAgent.findingList.noMatchesTitle');
    const action = empty.props.action as ReactElement<{ onPress: () => void }>;
    act(action.props.onPress);
    expect(root.findByType(EmptyState).props.title).toBe('securityAgent.findingList.emptyTitle');
    const filter = root.findByType(ScreenHeader).props.headerRight as ReactElement<{
      onPress: () => void;
    }>;
    act(filter.props.onPress);
    expect(mocks.bridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: DEFAULT_SECURITY_FINDING_FILTERS })
    );
  });

  it('centers a load failure without cached rows and retains Retry and refresh', async () => {
    findings.isError = true;
    const root = await mount();
    const error = root.findByType(QueryError);
    expect(error.props.placement).not.toBe('top');
    expect(root.findAllByType(EmptyState)).toHaveLength(0);
    act(error.props.onRetry as () => void);
    await refresh(error.props.refreshControl as ReactElement<{ onRefresh: () => void }>);
    expect(findings.refetch).toHaveBeenCalledTimes(2);
  });

  it('keeps loading ahead of errors and empty content', async () => {
    findings.isLoading = true;
    findings.isError = true;
    const root = await mount();
    expect(root.findAllByType(Skeleton)).toHaveLength(3);
    expect(root.findAllByType(EmptyState)).toHaveLength(0);
    expect(root.findAllByType(QueryError)).toHaveLength(0);
  });

  it.each([{ items: [] }, { items: [{ id: 'finding-1' }] }])(
    'keeps pagination errors inline with $items',
    async ({ items }) => {
      findings.data = { pages: [{ findings: items }] };
      findings.isError = true;
      findings.isFetchNextPageError = true;
      findings.hasNextPage = true;
      const root = await mount();
      const list = root.findByType(FlatList);
      expect(root.findAllByType(EmptyState)).toHaveLength(0);
      expect(root.findAllByType(QueryError)).toHaveLength(0);
      act(list.props.onEndReached as () => void);
      expect(findings.fetchNextPage).toHaveBeenCalledOnce();
      const footer = list.props.ListFooterComponent as ReactNode;
      mounted?.unmount();
      mounted = await renderWithProviders(createElement('Footer', null, footer));
      const error = mounted.renderer.root.findByType(QueryError);
      expect(error.props.placement).toBe('top');
      act(error.props.onRetry as () => void);
      expect(findings.fetchNextPage).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps expired filter guidance outside a scroller', async () => {
    mounted = await renderWithProviders(<SecurityAgentFilterFindingsRoute />);
    expect(mounted.renderer.root.findByType(EmptyState).props.placement).not.toBe('top');
    expect(mounted.renderer.root.findAllByType(PickerSheet)).toHaveLength(0);
  });
});
