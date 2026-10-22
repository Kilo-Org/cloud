// eslint-disable-next-line import/no-nodejs-modules -- Load the installed router without the native Expo entry.
import { createRequire } from 'node:module';
import type * as PathParserModule from 'expo-router/build/fork/getStateFromPath.js';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PushData } from '@kilocode/notifications';

import SecurityAgentScopeLayout, {
  unstable_settings,
} from '@/app/(app)/(tabs)/(3_profile)/security-agent/[scope]/_layout';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { notificationPathForData } from './notification-path';

const loadRouter = createRequire(import.meta.url);
const { getStateFromPath } = loadRouter(
  'expo-router/build/fork/getStateFromPath.js'
) as typeof PathParserModule;
type StackProps = { children?: ReactNode };

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
vi.mock('@/components/app-unlock-screen', () => ({
  appUnlockScreenLayout: ({ children }: { children: ReactNode }): ReactNode => children,
}));
// The security-agent stack now renders through the covered-screen gate; the
// pass-through mock keeps the scene as the focused screen under test.
vi.mock('@/components/app-screen-layout', () => ({
  appScreenLayout: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock('@/lib/form-sheet', () => ({
  useFormSheetDetents: () => ({ fullSheetDetent: 1 }),
  useFormSheetScreenOptions: () => ({
    presentation: 'formSheet',
    sheetAllowedDetents: [0.5, 1],
    sheetGrabberVisible: true,
    headerShown: false,
    sheetShouldOverflowTopInset: true,
  }),
}));

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

function parseScopeEntry(scope: string, path: string) {
  mountScope(scope);
  const stack = captured.stack;
  if (!stack) {
    throw new Error('Scope layout did not render a Stack');
  }
  // eslint-disable-next-line react/no-react-children -- Read the actual Stack.Screen declarations for this layout regression.
  const declared = Children.toArray(stack.children).map(child => {
    if (!isValidElement<{ name: string }>(child)) {
      throw new Error('Expected a Stack.Screen declaration');
    }
    return child.props;
  });
  const routeNames = [...declared.map(screen => screen.name), 'findings/index', 'findings/[id]'];
  const screens = Object.fromEntries(
    routeNames.map(name => [name, name.replaceAll(/\[([^/]+)\]/g, ':$1').replace(/\/?index$/, '')])
  );
  const parsed = getStateFromPath(path, {
    screens: {
      scope: {
        path: '(app)/(tabs)/(3_profile)/security-agent/:scope',
        initialRouteName: unstable_settings.anchor,
        screens,
      },
    },
  });
  const state = parsed?.routes[0]?.state;
  if (!state) {
    throw new Error('Notification path did not resolve into the scope stack');
  }
  return state;
}

describe.each(['personal', 'org-example'])('security notification history (%s)', scope => {
  it.each([
    { type: 'security_finding' },
    { type: 'security_lifecycle', event: 'analysis_completed' },
  ] as const)('resolves a $type entry above the scoped dashboard', payload => {
    const data = { ...payload, scope, findingId: 'finding-123' } satisfies PushData;
    const path = notificationPathForData(data);
    expect(path).toBe(
      `/(app)/(tabs)/(3_profile)/security-agent/${scope}/findings/finding-123?via=push`
    );
    const opened = parseScopeEntry(scope, path);
    expect(opened.index).toBe(1);
    expect(opened.routes.map(route => route.name)).toEqual(['index', 'findings/[id]']);
    expect(opened.routes[0]?.params).toMatchObject({ scope });
    expect(opened.routes[1]?.params).toMatchObject({ scope, id: 'finding-123', via: 'push' });
  });

  it('preserves scope and filters in a findings-list link', () => {
    const state = parseScopeEntry(
      scope,
      `/(app)/(tabs)/(3_profile)/security-agent/${scope}/findings?repoFullName=org%2Frepo&status=open&severity=critical&sortBy=sla_due_at_asc`
    );
    expect(state.routes.map(route => route.name)).toEqual(['index', 'findings/index']);
    expect(state.routes[0]?.params).toMatchObject({ scope });
    expect(state.routes[1]?.params).toMatchObject({
      scope,
      repoFullName: 'org/repo',
      status: 'open',
      severity: 'critical',
      sortBy: 'sla_due_at_asc',
    });
  });
});

it.each(['personal', 'org-example'])('mounts one command observer for scope %s', scope => {
  const tree = mountScope(scope);
  const observers = tree.root.findAll(
    node => (node.type as string) === 'SecurityAgentCommandObserver'
  );
  expect(observers).toHaveLength(1);
  expect(observers[0]?.props.scope).toBe(scope);
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
