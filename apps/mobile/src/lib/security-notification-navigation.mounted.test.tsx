/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts native trees without a DOM. */

// eslint-disable-next-line import/no-nodejs-modules -- Load the installed router without the native Expo entry.
import { createRequire } from 'node:module';
import type * as StackRouterModule from 'expo-router/build/react-navigation/routers/StackRouter.js';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PushData } from '@kilocode/notifications';

import SecurityAgentScopeLayout from '@/app/(app)/(tabs)/(3_profile)/security-agent/[scope]/_layout';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { notificationPathForData } from './notification-path';

const loadRouter = createRequire(import.meta.url);
const { StackActions, StackRouter: createStackRouter } = loadRouter(
  'expo-router/build/react-navigation/routers/StackRouter.js'
) as typeof StackRouterModule;
type RouterAction = Parameters<ReturnType<typeof createStackRouter>['getStateForAction']>[1];
type StackProps = { initialRouteName?: string; children?: ReactNode };

const captured = vi.hoisted(() => ({
  scope: 'personal' as string | string[] | undefined,
  stack: undefined as StackProps | undefined,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: captured.scope }),
  Stack: Object.assign(
    (props: StackProps): ReactNode => {
      captured.stack = props;
      return props.children;
    },
    { Screen: () => null }
  ),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/security-agent/security-agent-command-observer', () => ({
  SecurityAgentCommandObserver: 'SecurityAgentCommandObserver',
}));
vi.mock('@/components/privacy-cover-overlay', () => ({
  privacyScreenLayout: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetDetents: () => ({ fullSheetDetent: 1 }) }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

beforeEach(() => {
  captured.stack = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function mountScope(scope: string | string[] | undefined) {
  captured.scope = scope;
  act(() => {
    renderer = TestRenderer.create(createElement(SecurityAgentScopeLayout));
  });
  if (!renderer) {
    throw new Error('Scope layout did not mount');
  }
  return renderer;
}

function initializeScope(scope: string) {
  mountScope(scope);
  const stack = captured.stack;
  if (!stack) {
    throw new Error('Scope layout did not render a Stack');
  }
  // eslint-disable-next-line react/no-react-children -- Read the actual Stack.Screen declarations for this layout regression.
  const declaredNames = Children.toArray(stack.children).map(child => {
    if (!isValidElement<{ name: string }>(child)) {
      throw new Error('Expected a Stack.Screen declaration');
    }
    return child.props.name;
  });
  // Expo Router puts explicit declarations before the remaining file routes.
  const options = {
    routeNames: [...declaredNames, 'index', 'findings/index', 'findings/[id]'],
    routeParamList: {},
    routeGetIdList: {},
  };
  const router = createStackRouter({ initialRouteName: stack.initialRouteName });
  let state = router.getInitialState(options);
  return {
    initialState: state,
    apply: (action: RouterAction) => {
      const next = router.getStateForAction(state, action, options);
      if (!next) {
        throw new Error(`Router rejected ${action.type}`);
      }
      state = router.getRehydratedState(next, options);
      return state;
    },
  };
}

// Router-model POP is not evidence for a native gesture or the response handlers.
describe.each(['personal', 'org-example'])('security notification history (%s)', scope => {
  it.each([
    { type: 'security_finding' },
    { type: 'security_lifecycle', event: 'analysis_completed' },
  ] as const)('initializes index beneath a $type entry without a duplicate loop', payload => {
    const { initialState, apply } = initializeScope(scope);
    expect(initialState.routeNames).toEqual([
      'dismiss/[id]',
      'filter',
      'index',
      'findings/index',
      'findings/[id]',
    ]);
    expect(initialState.routes.map(route => route.name)).toEqual(['index']);
    expect(initialState.routes[0]?.params).toBeUndefined();

    const data = { ...payload, scope, findingId: 'finding-123' } satisfies PushData;
    const path = notificationPathForData(data);
    expect(path).toBe(
      `/(app)/(tabs)/(3_profile)/security-agent/${scope}/findings/finding-123?via=push`
    );
    const url = new URL(path, 'https://example.test');
    const segments = url.pathname.split('/');
    const action = {
      type: 'NAVIGATE',
      payload: {
        name: 'findings/[id]',
        params: {
          scope: segments.at(-3),
          id: segments.at(-1),
          via: url.searchParams.get('via'),
        },
      },
    } as const;
    const opened = apply(action);
    expect(opened.routes.map(({ name, params }) => ({ name, params }))).toEqual([
      { name: 'index', params: undefined },
      { name: 'findings/[id]', params: { scope, id: 'finding-123', via: 'push' } },
    ]);
    expect(apply(action)).toEqual(opened);
    expect(apply(StackActions.pop())).toEqual(initialState);
  });

  it('returns to the same filtered findings list before and after a partial reset', () => {
    const { apply } = initializeScope(scope);
    const list = apply(
      StackActions.push('findings/index', {
        scope,
        repoFullName: 'org/repo',
        status: 'open',
        severity: 'critical',
        sortBy: 'sla_due_at_asc',
      })
    );
    apply(StackActions.push('findings/[id]', { scope, id: 'finding-ordinary' }));
    expect(apply(StackActions.pop())).toEqual(list);

    const reset = apply({ type: 'RESET', payload: { routes: list.routes } });
    expect(reset.routes).toEqual(list.routes);
    apply(StackActions.push('findings/[id]', { scope, id: 'finding-ordinary' }));
    expect(apply(StackActions.pop())).toEqual(reset);
  });
});

it.each([{ scope: undefined }, { scope: '' }, { scope: ['personal', 'org-example'] }])(
  'rejects invalid scope $scope before mounting the Stack',
  ({ scope }) => {
    const tree = mountScope(scope);
    expect(tree.root.findByType(InvalidRouteState).props).toMatchObject({
      backTo: '/(app)/(tabs)/(3_profile)/security-agent',
    });
    expect(captured.stack).toBeUndefined();
  }
);
