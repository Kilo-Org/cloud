import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  type SecurityFindingFilters,
  toSecurityFindingParams,
} from '@kilocode/app-shared/security-agent';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SecurityAgentFilterFindingsRoute, {
  ErrorBoundary,
} from '@/app/(app)/security-agent/[scope]/filter';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
import { Skeleton } from '@/components/ui/skeleton';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

type RepositoryOption = { id: number; fullName: string };

type ModalProps = { onChange: (filters: SecurityFindingFilters) => void };
type SheetProps = { onDone: () => void; onCancel?: () => void; doneLabel?: string };
type ErrorProps = { message: string; onRetry: () => void };
type SheetConfig = {
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: number[];
};

const state = vi.hoisted(() => {
  const params: Record<string, string | undefined> = {};
  const repositories: {
    data: RepositoryOption[] | undefined;
    isPending: boolean;
    isPaused: boolean;
    isError: boolean;
    isFetching: boolean;
    refetch: () => void;
  } = {
    data: undefined,
    isPending: false,
    isPaused: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn<() => void>(),
  };
  const config: { data: SheetConfig | undefined } = { data: undefined };
  return { params, repositories, config };
});
const mocks = vi.hoisted(() => ({ back: vi.fn(), dismissTo: vi.fn(), retry: vi.fn() }));

vi.mock('react-native', () => ({ View: 'View' }));
// The route wraps its error boundary for crash reporting; the wrap is pass-through
// here so the fallback stays under test without loading the native SDK.
vi.mock('@sentry/react-native', () => ({
  wrapExpoRouterErrorBoundary: (component: unknown) => component,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: mocks.back, dismissTo: mocks.dismissTo }),
  useLocalSearchParams: () => ({ scope: 'personal', ...state.params }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/picker-sheet', () => ({ PickerSheet: 'PickerSheet' }));
// The shared scope guard renders the route's invalid state, whose icon set
// pulls the native icon module the mounted project cannot load.
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/security-agent/finding-filter-modal', () => ({
  FindingFilterModal: 'FindingFilterModal',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentConfig: () => state.config,
  useSecurityAgentRepositories: () => state.repositories,
}));

const REPOSITORIES = [
  { id: 1, fullName: 'acme/one' },
  { id: 2, fullName: 'acme/two' },
];

let mounted: RenderWithProvidersResult | null = null;

async function mount() {
  const result = await renderWithProviders(<SecurityAgentFilterFindingsRoute />);
  mounted = result;
  return result.renderer.root;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.params = {};
  state.repositories.data = REPOSITORIES;
  state.repositories.isPending = false;
  state.repositories.isPaused = false;
  state.repositories.isError = false;
  state.repositories.isFetching = false;
  state.config.data = { repositorySelectionMode: 'all', selectedRepositoryIds: [] };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

describe('Security Agent findings filter sheet', () => {
  it('starts from the filters its route was opened with', async () => {
    state.params = { severity: 'high', repoFullName: 'acme/two', overdue: 'true' };
    const root = await mount();
    const sheet = root.findByType(PickerSheet);
    const sheetProps = sheet.props as SheetProps & { title?: string };
    expect(sheetProps.title).toBe('securityAgent.filter.title');
    expect(sheetProps.doneLabel).toBe('common.apply');
    const modalProps = root.findByType(FindingFilterModal).props as ModalProps & {
      filters: SecurityFindingFilters;
    };
    expect(modalProps.filters).toEqual({
      ...DEFAULT_SECURITY_FINDING_FILTERS,
      severity: 'high',
      repoFullName: 'acme/two',
      overdue: true,
    });
  });

  it('offers the in-scope repositories as options', async () => {
    state.config.data = { repositorySelectionMode: 'selected', selectedRepositoryIds: [2] };
    const root = await mount();
    const modalProps = root.findByType(FindingFilterModal).props as ModalProps & {
      repositories: RepositoryOption[];
    };
    expect(modalProps.repositories).toEqual([{ id: 2, fullName: 'acme/two' }]);
  });

  it('applies the draft back to the findings route', async () => {
    const root = await mount();
    const modalProps = root.findByType(FindingFilterModal).props as ModalProps;
    await act(async () => {
      modalProps.onChange({ ...DEFAULT_SECURITY_FINDING_FILTERS, status: 'all', outcome: 'fixed' });
      await Promise.resolve();
    });
    const sheetProps = root.findByType(PickerSheet).props as SheetProps;
    await act(async () => {
      sheetProps.onDone();
      await Promise.resolve();
    });
    expect(mocks.dismissTo).toHaveBeenCalledWith({
      pathname: '/(app)/security-agent/[scope]/findings',
      params: {
        scope: 'personal',
        ...toSecurityFindingParams({
          ...DEFAULT_SECURITY_FINDING_FILTERS,
          status: 'all',
          outcome: 'fixed',
        }),
      },
    });
  });

  it('cancels without touching the findings filters', async () => {
    const root = await mount();
    const sheetProps = root.findByType(PickerSheet).props as SheetProps;
    await act(async () => {
      sheetProps.onCancel?.();
      await Promise.resolve();
    });
    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTo).not.toHaveBeenCalled();
  });

  it('shows progress rows while the repository options load', async () => {
    state.repositories.data = undefined;
    state.repositories.isPending = true;
    const root = await mount();
    expect(root.findAllByType(Skeleton).length).toBeGreaterThan(0);
    expect(root.findAllByType(FindingFilterModal)).toHaveLength(0);
    // The progress is also announced, not only drawn.
    expect(root.findByType('AccessibleStatus').props.message).toBe('common.loading');
    // The header controls stay usable while the options are prepared.
    expect((root.findByType(PickerSheet).props as SheetProps).onDone).toBeTypeOf('function');
  });

  it('reports a paused fetch as an offline retry instead of an endless skeleton', async () => {
    state.repositories.data = undefined;
    state.repositories.isPending = true;
    state.repositories.isPaused = true;
    const root = await mount();
    const errorProps = root.findByType(QueryError).props as ErrorProps & { variant?: string };
    expect(errorProps.variant).toBe('offline');
    expect(root.findAllByType(Skeleton)).toHaveLength(0);
  });

  it('keeps the sheet open with an inline retry when the repository fetch fails', async () => {
    state.repositories.isError = true;
    const root = await mount();
    const errorProps = root.findByType(QueryError).props as ErrorProps;
    expect(errorProps.message).toBe('common.couldNotLoadRepositories');
    expect((root.findByType(PickerSheet).props as SheetProps).doneLabel).toBe('common.apply');
    await act(async () => {
      errorProps.onRetry();
      await Promise.resolve();
    });
    expect(state.repositories.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a render failure inside the sheet instead of the app root', async () => {
    const result = await renderWithProviders(
      <ErrorBoundary error={new Error('boom')} retry={mocks.retry} />
    );
    mounted = result;
    const root = result.renderer.root;
    const errorProps = root.findByType(QueryError).props as ErrorProps;
    expect(errorProps.message).toBe('common.somethingWentWrong');
    await act(async () => {
      errorProps.onRetry();
      await Promise.resolve();
    });
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it('leaves the sheet from a render failure without applying anything', async () => {
    const result = await renderWithProviders(
      <ErrorBoundary error={new Error('boom')} retry={mocks.retry} />
    );
    mounted = result;
    const goBack = result.renderer.root.findByType('Button').props as { onPress: () => void };
    await act(async () => {
      goBack.onPress();
      await Promise.resolve();
    });
    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTo).not.toHaveBeenCalled();
  });
});
