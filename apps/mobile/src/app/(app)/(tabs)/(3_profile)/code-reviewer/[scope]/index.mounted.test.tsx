/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CodeReviewerScopeRoute from './index';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/code-reviewer/platform-list-screen', () => ({
  PlatformListScreen: 'PlatformListScreen',
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
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(CodeReviewerScopeRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

describe('CodeReviewerScopeRoute invalid scope', () => {
  it('renders InvalidRouteState with the profile backTo when scope is undefined', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: undefined });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/(tabs)/(3_profile)');
    expect(findByType(renderer.root, 'PlatformListScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders InvalidRouteState with the profile backTo when scope is an array', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: ['personal', 'org'] });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/(tabs)/(3_profile)');
    expect(findByType(renderer.root, 'PlatformListScreen')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerScopeRoute valid scope', () => {
  it('renders the platform list with the parsed scope', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal' });
    const renderer = mountRoute();

    const screen = findByType(renderer.root, 'PlatformListScreen');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'scope')).toBe('personal');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
