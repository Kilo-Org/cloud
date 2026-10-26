import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  toSecurityFindingParams,
} from '@kilocode/app-shared/security-agent';
import { FlashList } from '@shopify/flash-list';
import { act, type ComponentProps, createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { renderWithProviders } from '@/test/render-with-providers';
import { FindingListScreen } from './finding-list-screen';

type FindingFixture = {
  id: string;
  status?: string;
  analysis_status?: string | null;
  remediationSummary?: { status: string; prUrl: string | null } | null;
};
type FindingPages = { pages: { findings: FindingFixture[] }[] };
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
const repositories = vi.hoisted(() => ({
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const capacity = vi.hoisted(() => ({
  state: 'available' as 'loading' | 'error' | 'available' | 'full',
  refetch: vi.fn(),
}));

function analyzableFinding(id: string): FindingFixture {
  return { id, status: 'open', analysis_status: null, remediationSummary: null };
}

function analyzedFinding(id: string): FindingFixture {
  return { id, status: 'fixed', analysis_status: 'completed', remediationSummary: null };
}

/** The rendered capacity line for `securityAgent.analysis.<key>`, if any. */
function capacityCopy(root: Root, key: 'capacityFull' | 'couldNotCheckCapacity') {
  return root
    .findAllByType(Text)
    .filter(node => node.props.children === `securityAgent.analysis.${key}`);
}
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  push: vi.fn(),
  setParams: vi.fn(),
  back: vi.fn(),
  dismissTo: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
}));
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: mocks.push,
    back: mocks.back,
    setParams: mocks.setParams,
    dismissTo: mocks.dismissTo,
  }),
  useFocusEffect: vi.fn(),
  useLocalSearchParams: () => ({ scope: 'personal' }),
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
  useSecurityAgentRepositories: () => repositories,
  useSecurityAnalysisCapacity: () => capacity,
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

type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;
type Root = Mounted['renderer']['root'];

let mounted: Mounted | undefined = undefined;
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
  repositories.isLoading = false;
  repositories.isError = false;
  repositories.refetch.mockResolvedValue({});
  capacity.state = 'available';
  capacity.refetch.mockReset();
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
    expect(root.findAllByType(FlashList)).toHaveLength(0);
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
    // Clearing writes the default filters into this route's params, so the URL
    // and the rendered list cannot disagree.
    expect(mocks.setParams).toHaveBeenCalledWith(
      toSecurityFindingParams(DEFAULT_SECURITY_FINDING_FILTERS)
    );
    const filter = root.findByType(ScreenHeader).props.headerRight as ReactElement<{
      onPress: () => void;
    }>;
    act(filter.props.onPress);
    // The sheet is pushed with the filters the list currently shows.
    expect(mocks.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/security-agent/[scope]/filter',
      params: { scope: 'personal', severity: 'high' },
    });
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

  it('keeps the filter available and offers a repositories retry while that fetch failed', async () => {
    repositories.isError = true;
    const root = await mount();
    const filter = root.findByType(ScreenHeader).props.headerRight as ReactElement<{
      onPress: () => void;
      disabled?: boolean;
    }>;
    // The sheet owns its own loading/error state, so the control never becomes
    // a silent no-op: the reader can always open it and retry from inside.
    expect(filter.props.disabled).toBeUndefined();

    const errors = root.findAllByType(QueryError);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('common.couldNotLoadRepositories');
    expect(errors[0]?.props.placement).toBe('top');

    act(filter.props.onPress as () => void);
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/(app)/security-agent/[scope]/filter',
      params: { scope: 'personal' },
    });

    act(errors[0]?.props.onRetry as () => void);
    expect(repositories.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows no repositories error once the fetch succeeds', async () => {
    const root = await mount();
    expect(root.findAllByType(QueryError)).toHaveLength(0);
  });

  it('retries the repositories query on pull-to-refresh', async () => {
    const root = await mount();
    const empty = root.findByType(EmptyState);

    await refresh(empty.props.refreshControl as ReactElement<{ onRefresh: () => void }>);
    expect(repositories.refetch).toHaveBeenCalledTimes(1);
    expect(capacity.refetch).toHaveBeenCalledTimes(1);
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
      const list = root.findByType(FlashList);
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

  it('spaces rows with a measured separator instead of the ignored contentContainerStyle gap', async () => {
    findings.data = { pages: [{ findings: [{ id: 'finding-1' }] }] };
    const root = await mount();
    const list = root.findByType(FlashList);
    // FlashList v2 positions every cell absolutely and ignores `gap`, so the
    // 12px inter-row gap must ride on the measured separator, not the content
    // style — otherwise every card renders flush against the next.
    expect(list.props.contentContainerStyle).not.toHaveProperty('gap');
    const Separator = list.props.ItemSeparatorComponent as () => ReactElement;
    mounted?.unmount();
    mounted = await renderWithProviders(createElement(Separator));
    const spacer = mounted.renderer.root.findByType('View');
    expect(spacer.props.className).toBe('h-3');
  });

  it('restores the header and footer boundary gaps the separator cannot cover', async () => {
    findings.data = { pages: [{ findings: [{ id: 'finding-1' }] }] };
    const root = await mount();
    const list = root.findByType(FlashList);
    // The old content-container `gap-3` also sat between the header and the
    // first row and between the last row and the footer. FlashList's separator
    // only spans items, so each boundary carries its own 12px pad.
    const header = list.props.ListHeaderComponent as ReactElement<{ className: string }>;
    const footer = list.props.ListFooterComponent as ReactElement<{ className: string }>;
    expect(header.props.className).toBe('pb-3');
    expect(footer.props.className).toBe('pt-3');
  });

  async function mountListHeader() {
    const root = await mount();
    const list = root.findByType(FlashList);
    const header = list.props.ListHeaderComponent as ReactNode;
    mounted?.unmount();
    mounted = await renderWithProviders(createElement('Header', null, header));
    return mounted.renderer.root;
  }

  it('explains a full analysis capacity once above the analyzable rows', async () => {
    capacity.state = 'full';
    findings.data = { pages: [{ findings: [analyzableFinding('a'), analyzableFinding('b')] }] };
    const header = await mountListHeader();
    expect(capacityCopy(header, 'capacityFull')).toHaveLength(1);
  });

  it.each([
    { state: 'full', rows: [analyzedFinding('a')] },
    { state: 'loading', rows: [analyzableFinding('a')] },
    { state: 'available', rows: [analyzableFinding('a')] },
  ] as const)('keeps the capacity explanation hidden while $state', async ({ state, rows }) => {
    capacity.state = state;
    findings.data = { pages: [{ findings: [...rows] }] };
    const header = await mountListHeader();
    expect(capacityCopy(header, 'capacityFull')).toHaveLength(0);
    expect(capacityCopy(header, 'couldNotCheckCapacity')).toHaveLength(0);
  });
});
