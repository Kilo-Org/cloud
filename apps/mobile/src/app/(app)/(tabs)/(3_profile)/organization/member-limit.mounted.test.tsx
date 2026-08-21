/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MemberLimitRoute from './member-limit';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/organization/member-limit-sheet', () => ({
  MemberLimitSheet: 'MemberLimitSheet',
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
    ref.current = TestRenderer.create(createElement(MemberLimitRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

describe('MemberLimitRoute invalid memberId', () => {
  it('renders InvalidRouteState with the organization backTo when memberId is undefined', () => {
    useLocalSearchParamsMock.mockReturnValue({ memberId: undefined });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/(tabs)/(3_profile)/organization');
    expect(findByType(renderer.root, 'MemberLimitSheet')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders InvalidRouteState with the organization backTo when memberId is an array', () => {
    useLocalSearchParamsMock.mockReturnValue({ memberId: ['m-1', 'm-2'] });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)/(tabs)/(3_profile)/organization');
    expect(findByType(renderer.root, 'MemberLimitSheet')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('MemberLimitRoute valid memberId', () => {
  it('renders the member limit sheet with the parsed memberId', () => {
    useLocalSearchParamsMock.mockReturnValue({ memberId: 'm-1' });
    const renderer = mountRoute();

    const screen = findByType(renderer.root, 'MemberLimitSheet');
    expect(screen).toHaveLength(1);
    expect(propOf(screen[0], 'memberId')).toBe('m-1');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
