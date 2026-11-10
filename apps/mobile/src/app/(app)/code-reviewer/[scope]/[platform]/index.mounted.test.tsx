// The overview route must take the `scope`+`platform` pair the `[platform]`
// layout validated instead of re-reading its own route params: expo-router
// seeds a nested navigator's initial screen with no params, so the child's own
// params can be absent — or belong to another route — while the layout's are
// valid. Indexing platform capabilities with that unvalidated value threw
// `Cannot read properties of undefined (reading 'label')`.

import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ReviewerScopePlatform } from '@/lib/code-reviewer-config';
import { ReviewerRouteParamsProvider } from '@/lib/hooks/use-reviewer-route-params';

import CodeReviewerPlatformRoute from './index';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/code-reviewer/platform-overview-screen', () => ({
  PlatformOverviewScreen: 'PlatformOverviewScreen',
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

function mountRoute(element: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(element);
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

function mountUnderLayout(params: ReviewerScopePlatform): TestRenderer.ReactTestRenderer {
  return mountRoute(
    <ReviewerRouteParamsProvider params={params}>
      <CodeReviewerPlatformRoute />
    </ReviewerRouteParamsProvider>
  );
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

describe('CodeReviewerPlatformRoute under the validated layout', () => {
  it('renders the overview for that pair when its own route params are empty', () => {
    useLocalSearchParamsMock.mockReturnValue({});
    const renderer = mountUnderLayout({
      kind: 'org',
      organizationId: 'org-1',
      platform: 'gitlab',
    });

    const screen = findByType(renderer.root, 'PlatformOverviewScreen');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'scope')).toBe('org-1');
    expect(propOf(screen[0], 'platform')).toBe('gitlab');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the layout-validated pair when its own route params name another platform', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal', platform: 'github' });
    const renderer = mountUnderLayout({
      kind: 'org',
      organizationId: 'org-1',
      platform: 'bitbucket',
    });

    const screen = findByType(renderer.root, 'PlatformOverviewScreen');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'scope')).toBe('org-1');
    expect(propOf(screen[0], 'platform')).toBe('bitbucket');

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the personal scope under the personal pair', () => {
    useLocalSearchParamsMock.mockReturnValue({});
    const renderer = mountUnderLayout({ kind: 'personal', platform: 'github' });

    const screen = findByType(renderer.root, 'PlatformOverviewScreen');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'scope')).toBe('personal');
    expect(propOf(screen[0], 'platform')).toBe('github');

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerPlatformRoute outside the validated layout', () => {
  it('renders InvalidRouteState instead of indexing an unvalidated platform', () => {
    useLocalSearchParamsMock.mockReturnValue({});
    const renderer = mountRoute(createElement(CodeReviewerPlatformRoute));

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/code-reviewer');
    expect(findByType(renderer.root, 'PlatformOverviewScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
