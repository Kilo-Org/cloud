import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CodeReviewerReviewDetailRoute from './[id]';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());
const useRetireCoveredSourceMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

// The retire itself is the hook's contract (`retire-covered-source.ts`); what
// this route has to get right is the pair of route names it hands it.
vi.mock('@/lib/navigation/retire-covered-source', () => ({
  useRetireCoveredSource: useRetireCoveredSourceMock,
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/code-reviewer/review-detail-screen', () => ({
  ReviewDetailScreen: 'ReviewDetailScreen',
}));

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(CodeReviewerReviewDetailRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
  useRetireCoveredSourceMock.mockReset();
});

describe('CodeReviewerReviewDetailRoute invalid scope', () => {
  it('renders InvalidRouteState with the Code Reviewer backTo when scope is undefined', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: undefined, id: 'rev-1' });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/code-reviewer');
    expect(findByType(renderer.root, 'ReviewDetailScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders InvalidRouteState with the Code Reviewer backTo when scope is an array', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: ['personal', 'org'], id: 'rev-1' });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/code-reviewer');
    expect(findByType(renderer.root, 'ReviewDetailScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerReviewDetailRoute invalid id', () => {
  it('renders InvalidRouteState with the scope reviews backTo when id is undefined', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal', id: undefined });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/code-reviewer/personal/reviews');
    expect(findByType(renderer.root, 'ReviewDetailScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders InvalidRouteState with the scope reviews backTo when id is an array', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal', id: ['rev-1', 'rev-2'] });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/code-reviewer/personal/reviews');
    expect(findByType(renderer.root, 'ReviewDetailScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerReviewDetailRoute retire of the create hand-off source', () => {
  it('mounts one retire per form entry, each with its own guard beneath', () => {
    // The form is opened from the reviews list and from the scope's platform
    // list (`review-list-screen.tsx`, `platform-list-screen.tsx`), so the
    // hand-off's source sits above one of those two screens. Both names are
    // paths below `(app)/_layout.tsx`: no directory between this leaf and that
    // Stack is a layout.
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal', id: 'rev-1' });
    const renderer = mountRoute();

    expect(useRetireCoveredSourceMock).toHaveBeenCalledTimes(2);
    expect(useRetireCoveredSourceMock).toHaveBeenNthCalledWith(
      1,
      'code-reviewer/[scope]/manual-review',
      'code-reviewer/[scope]/reviews/index'
    );
    expect(useRetireCoveredSourceMock).toHaveBeenNthCalledWith(
      2,
      'code-reviewer/[scope]/manual-review',
      'code-reviewer/[scope]/index'
    );

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerReviewDetailRoute valid params', () => {
  it('renders the review detail with the parsed scope and id', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal', id: 'rev-1' });
    const renderer = mountRoute();

    const screen = findByType(renderer.root, 'ReviewDetailScreen');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'scope')).toBe('personal');
    expect(propOf(screen[0], 'reviewId')).toBe('rev-1');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
