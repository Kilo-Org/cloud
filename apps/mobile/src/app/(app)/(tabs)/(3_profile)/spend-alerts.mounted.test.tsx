import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SpendAlertsRoute from './spend-alerts';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/organization/spend-alerts-screen', () => ({
  SpendAlertsScreen: 'SpendAlertsScreen',
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SpendAlertsRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  mounted = ref.current;
  return ref.current;
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function screenScope(): unknown {
  const screens = findByType(mountRoute().root, 'SpendAlertsScreen');
  expect(screens).toHaveLength(1);
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return screens[0]?.props.organizationId;
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

// The renderer's unmount is what releases the tree it holds, as the sibling
// route suites do.
afterEach(() => {
  const renderer = mounted;
  mounted = undefined;
  if (renderer === undefined) {
    return;
  }
  act(() => {
    renderer.unmount();
  });
});

describe('SpendAlertsRoute organization scope', () => {
  it('keeps the single organization id the link names', () => {
    useLocalSearchParamsMock.mockReturnValue({ org: 'org-b' });

    expect(screenScope()).toBe('org-b');
  });

  it('takes the first id of a repeated org parameter', () => {
    useLocalSearchParamsMock.mockReturnValue({ org: ['org-b', 'org-c'] });

    expect(screenScope()).toBe('org-b');
  });

  it.each<(string | string[] | undefined)[]>([[undefined], [''], [['', 'org-b']], [[]]])(
    'opens the personal scope for %j',
    org => {
      useLocalSearchParamsMock.mockReturnValue({ org });

      expect(screenScope()).toBeUndefined();
    }
  );
});
