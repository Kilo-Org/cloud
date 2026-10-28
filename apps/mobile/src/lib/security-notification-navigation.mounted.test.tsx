import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PushData } from '@kilocode/notifications';

import SecurityAgentScopeLayout, {
  unstable_settings,
} from '@/app/(app)/security-agent/[scope]/_layout';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { notificationPathForData } from './notification-path';

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

function declaredScopeRoutes(): string[] {
  const stack = captured.stack;
  if (!stack) {
    throw new Error('Scope layout did not render a Stack');
  }
  // eslint-disable-next-line react/no-react-children -- Read actual Stack.Screen declarations.
  return Children.toArray(stack.children).map(child => {
    if (!isValidElement<{ name: string }>(child)) {
      throw new Error('Expected a Stack.Screen declaration');
    }
    return child.props.name;
  });
}

describe.each(['personal', 'org-example'])('security notification routes (%s)', scope => {
  it.each([
    { type: 'security_finding' },
    { type: 'security_lifecycle', event: 'analysis_completed' },
  ] as const)('targets the scoped finding route for $type notifications', payload => {
    const data = { ...payload, scope, findingId: 'finding-123' } satisfies PushData;
    const path = notificationPathForData(data);
    expect(path).toBe(`/(app)/security-agent/${scope}/findings/finding-123?via=push`);

    mountScope(scope);
    expect(unstable_settings.anchor).toBe('index');
    expect(declaredScopeRoutes()).toEqual(['index', 'dismiss/[id]', 'filter']);

    const url = new URL(path, 'https://example.test');
    expect(url.pathname.split('/').filter(Boolean)).toEqual([
      '(app)',
      'security-agent',
      scope,
      'findings',
      'finding-123',
    ]);
    expect(url.searchParams.get('via')).toBe('push');
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
      backTo: '/(app)/security-agent',
    });
    expect(captured.stack).toBeUndefined();
  }
);
