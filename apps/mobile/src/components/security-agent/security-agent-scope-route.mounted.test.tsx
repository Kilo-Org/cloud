import { type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SecurityAgentScopeProvider, useSecurityAgentScope } from './security-agent-scope-route';

type RouteParams = Record<string, string | string[] | undefined>;

const params = vi.hoisted(() => {
  const state: { current: RouteParams } = { current: {} };
  return state;
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));

const ORGANIZATION_ID = '3f1a1e42-3c1b-4f5f-9d1b-2b1b8f6f0a11';

let latest: string | null | undefined = undefined;

function Probe() {
  latest = useSecurityAgentScope();
  return null;
}

function mount(node: ReactElement) {
  act(() => {
    TestRenderer.create(node);
  });
  return latest;
}

describe('useSecurityAgentScope', () => {
  beforeEach(() => {
    latest = undefined;
    params.current = {};
  });

  it('reads the route’s own scope when the route carries one', () => {
    params.current = { scope: ORGANIZATION_ID };

    expect(mount(<Probe />)).toBe(ORGANIZATION_ID);
  });

  it('rejects an own scope that names no scope even under a validated layout', () => {
    params.current = { scope: 'undefined' };

    expect(
      mount(
        <SecurityAgentScopeProvider scope="personal">
          <Probe />
        </SecurityAgentScopeProvider>
      )
    ).toBeNull();
  });

  it('uses the layout scope when the route carries no param of its own', () => {
    params.current = {};

    expect(
      mount(
        <SecurityAgentScopeProvider scope="personal">
          <Probe />
        </SecurityAgentScopeProvider>
      )
    ).toBe('personal');
  });

  it('is invalid with no param and no validated layout', () => {
    params.current = {};

    expect(mount(<Probe />)).toBeNull();
  });
});
