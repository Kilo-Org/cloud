/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as pr-review-discussion-tab.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';

import { PrReviewFileNavigatorScreen } from './pr-review-file-navigator-screen';

const queryState = vi.hoisted(() => ({
  data: null as { headSha: string; counts: { changedFiles: number } } | null,
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

const scopeState: { ref: ProviderPrRef; isReady: boolean } = vi.hoisted(() => ({
  ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
  isReady: true,
}));

vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => queryState }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('@/lib/pr-review/provider-pr-queries', () => ({
  useProviderPrQueries: () => ({ ...scopeState, overviewOptions: () => ({}) }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888' }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
// The screen renders the UI spinner while loading; the real one reaches the
// motion policy (expo-battery), which stays unmocked in this pure harness.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/pr-review/diff/pr-diff-file-navigator', () => ({
  PrDiffFileNavigator: 'PrDiffFileNavigator',
}));

function mountScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrReviewFileNavigatorScreen));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function find(renderer: TestRenderer.ReactTestRenderer, type: string) {
  return renderer.root.find(node => String(node.type) === type);
}

function trpcError(code: string): unknown {
  return Object.assign(new Error(code), { data: { code }, shape: { data: { code } } });
}

describe('PrReviewFileNavigatorScreen states', () => {
  beforeEach(() => {
    queryState.data = null;
    queryState.isLoading = false;
    queryState.isError = false;
    queryState.isFetching = false;
    queryState.error = null;
    queryState.refetch.mockClear();
    scopeState.ref = { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 };
    scopeState.isReady = true;
  });

  it('titles the sheet with the provider ref, not a GitHub triple', () => {
    expect(find(mountScreen(), 'ScreenHeader').props.eyebrow).toBe('group/sub/repo!12');
  });

  it('shows one loading indicator while the first load is in flight', () => {
    queryState.isLoading = true;
    const renderer = mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(
      1
    );
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
  });

  it('hands the navigator the resolved provider identity on the happy path', () => {
    queryState.data = { headSha: 'abc123', counts: { changedFiles: 4 } };
    const navigator = find(mountScreen(), 'PrDiffFileNavigator');
    expect(navigator.props).toMatchObject({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      headSha: 'abc123',
      changedFiles: 4,
    });
  });

  it('offers a retry only for a transient failure', () => {
    queryState.isError = true;
    queryState.error = trpcError('INTERNAL_SERVER_ERROR');
    const error = find(mountScreen(), 'QueryError');
    expect(error.props.variant).toBe('server');
    act(() => {
      (error.props.onRetry as () => void)();
    });
    expect(queryState.refetch).toHaveBeenCalled();
  });

  it.each([
    ['FORBIDDEN', 'permission'],
    ['NOT_FOUND', 'not-found'],
  ])('renders %s as a terminal state with no retry', (code, variant) => {
    queryState.isError = true;
    queryState.error = trpcError(code);
    const error = find(mountScreen(), 'QueryError');
    expect(error.props.variant).toBe(variant);
    expect(error.props.onRetry).toBeUndefined();
  });

  it('points a broken connection at the reconnect notice instead of a retry', () => {
    queryState.isError = true;
    queryState.error = trpcError('PRECONDITION_FAILED');
    const renderer = mountScreen();
    expect(find(renderer, 'PrReviewReconnectNotice')).toBeDefined();
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
  });
});
