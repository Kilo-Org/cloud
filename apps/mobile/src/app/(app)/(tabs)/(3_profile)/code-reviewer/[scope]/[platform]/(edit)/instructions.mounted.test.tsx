// Custom-instructions route state contract: a failed config load must show a
// retryable QueryError instead of the endless skeleton that the explorer
// finding (code-reviews, 2026-09-30) captured on a network drop. The config
// query is mocked so each state is driven directly through the route JSX.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import InstructionsRoute from './instructions';

const reviewConfig = vi.hoisted(() => ({
  data: null as unknown,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));

const queryErrors = vi.hoisted(() => ({
  rendered: [] as {
    variant?: string;
    title?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }[],
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: 'personal', platform: 'github' }),
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock('react-native', () => ({ TextInput: 'TextInput', View: 'View' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    title?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }) => {
    queryErrors.rendered.push(props);
    return null;
  },
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: () => reviewConfig,
  useSaveReviewConfig: () => ({ isPending: false, mutate: vi.fn() }),
}));

function renderRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(InstructionsRoute));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function countByType(renderer: TestRenderer.ReactTestRenderer, type: string): number {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === type
  ).length;
}

beforeEach(() => {
  reviewConfig.data = null;
  reviewConfig.isError = false;
  reviewConfig.isFetching = false;
  reviewConfig.refetch.mockClear();
  queryErrors.rendered = [];
});

describe('Custom instructions route config load', () => {
  it('shows an error with Retry instead of the endless skeleton when the config fails', () => {
    reviewConfig.isError = true;

    const renderer = renderRoute();

    expect(queryErrors.rendered).toHaveLength(1);
    expect(queryErrors.rendered[0]?.variant).toBe('server');
    expect(queryErrors.rendered[0]?.onRetry).toBeTypeOf('function');
    expect(countByType(renderer, 'Skeleton')).toBe(0);
    // The full-body error renders outside the page scroller, so QueryError's
    // own centered ScrollView is not nested in one (repos.tsx / review-list).
    expect(countByType(renderer, 'ScrollView')).toBe(0);

    queryErrors.rendered[0]?.onRetry?.();
    expect(reviewConfig.refetch).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the skeleton while the config loads', () => {
    const renderer = renderRoute();

    expect(countByType(renderer, 'Skeleton')).toBeGreaterThan(0);
    expect(countByType(renderer, 'ScrollView')).toBe(1);
    expect(queryErrors.rendered).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows the instructions editor once the config loads', () => {
    reviewConfig.data = { customInstructions: 'prefer explicit errors' };

    const renderer = renderRoute();

    expect(countByType(renderer, 'TextInput')).toBe(1);
    expect(countByType(renderer, 'Skeleton')).toBe(0);
    expect(countByType(renderer, 'ScrollView')).toBe(1);
    expect(queryErrors.rendered).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
