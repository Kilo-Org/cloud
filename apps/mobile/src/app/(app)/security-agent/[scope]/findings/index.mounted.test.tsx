import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SecurityAgentFindingListRoute from './index';

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

vi.mock('@/components/security-agent/finding-list-screen', () => ({
  FindingListScreen: 'FindingListScreen',
}));

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SecurityAgentFindingListRoute));
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

describe('SecurityAgentFindingListRoute covered-source retire', () => {
  it('retires the finding detail that swapped in this list, guarded by the dashboard', () => {
    // Back on a detail with no local history pushes this list above the detail
    // (`finding-detail-screen.tsx` -> `useStackSafeReplace`), and the group's
    // scene repair has already put the dashboard (`index`) directly beneath
    // that detail. `findings/[id]` is this screen's sibling route, named by its
    // path below the `[scope]` Stack.
    useLocalSearchParamsMock.mockReturnValue({ scope: 'personal' });
    const renderer = mountRoute();

    expect(useRetireCoveredSourceMock).toHaveBeenCalledExactlyOnceWith('findings/[id]', 'index');

    act(() => {
      renderer.unmount();
    });
  });
});
