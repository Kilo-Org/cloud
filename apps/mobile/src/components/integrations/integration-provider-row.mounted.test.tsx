/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression tests. */

// An uninstalled row's body has to start the same Connect action as its trailing
// button: the row itself is the largest control on the screen, and a body that
// swallowed the tap left the hub looking inert. Installed and pending rows must
// stay inert — their action is destructive, or not known yet.

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type IntegrationRow } from '@/lib/integrations/integration-rows';
import { type IntegrationScope } from '@/lib/integrations/provider-catalog';
import { act, TestRenderer } from '@/test/renderer';

import { IntegrationProviderRow } from './integration-provider-row';

const calls = vi.hoisted(() => ({
  connect: vi.fn<() => void>(),
  disconnect: vi.fn<() => void>(),
  manageOnWeb: vi.fn<() => void>(),
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));
// The shared row is a host element here, so the wrapper the row builds around it
// is the only pressable above the row's content.
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string; trailing?: ReactNode }) =>
    createElement('RowMock', { title: props.title }, props.trailing ?? null),
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  CircleDot: 'CircleDot',
  GitBranch: 'GitBranch',
  GitCommit: 'GitCommit',
  GitMerge: 'GitMerge',
  MessageSquare: 'MessageSquare',
}));

function integrationRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    provider: 'github',
    installed: false,
    accountLabel: null,
    disconnectIntegrationId: null,
    canDisconnectNatively: false,
    webManaged: false,
    actionPending: false,
    ...overrides,
  };
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: {
  row: IntegrationRow;
  scope: IntegrationScope;
  role?: string;
  connecting?: boolean;
}): TestRenderer.ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(
      createElement(IntegrationProviderRow, {
        row: props.row,
        scope: props.scope,
        role: props.role,
        connecting: props.connecting ?? false,
        disconnecting: false,
        onConnect: calls.connect,
        onDisconnect: calls.disconnect,
        onManageOnWeb: calls.manageOnWeb,
      })
    );
  });
  if (!renderer) {
    throw new Error('the provider row did not render');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  for (const spy of Object.values(calls)) {
    spy.mockClear();
  }
});

/** Whether the node is the row's own content, below the wrapper under test. */
function insideContent(node: TestRenderer.ReactTestInstance): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    // The configured row is a host element here, so its type name is the only
    // marker the renderer keeps.
    if (String(parent.type) === 'RowMock') {
      return true;
    }
  }
  return false;
}

/**
 * Every press handler the row renders above its content: the body wrapper when
 * it exists, and nothing else. Found by the prop, not by element type, so the
 * assertion holds whether the wrapper is a host view or a component.
 */
function bodyPresses(root: TestRenderer.ReactTestInstance) {
  return root.findAll(node => typeof node.props.onPress === 'function' && !insideContent(node));
}

/** Invokes a control the test found, matching the renderer's synchronous act. */
function press(node: TestRenderer.ReactTestInstance) {
  const onPress = node.props.onPress as (() => void) | undefined;
  if (!onPress) {
    throw new Error('the control has no press handler');
  }
  act(() => {
    onPress();
  });
}

describe('IntegrationProviderRow body press', () => {
  it.each([
    { scope: 'personal' as const, role: undefined },
    { scope: 'organization' as const, role: 'owner' },
  ])('starts Connect from the body of an uninstalled $scope row', ({ scope, role }) => {
    const root = renderRow({ row: integrationRow(), scope, role });

    const bodies = bodyPresses(root);
    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    if (!body) {
      throw new Error('the uninstalled row rendered no body press');
    }
    press(body);

    expect(calls.connect).toHaveBeenCalledOnce();
    expect(calls.disconnect).not.toHaveBeenCalled();
    expect(calls.manageOnWeb).not.toHaveBeenCalled();
  });

  it('makes the row the one named Connect control', () => {
    const root = renderRow({ row: integrationRow(), scope: 'personal' });

    const [body] = bodyPresses(root);
    if (!body) {
      throw new Error('the uninstalled row rendered no body press');
    }
    // One stop, named and typed: the row spans the series and the trailing
    // button is only its face, kept out of the tree.
    expect(body.props.accessibilityRole).toBe('button');
    expect(body.props.accessibilityLabel).toBe('Connect. GitHub');
    expect(body.props.accessibilityState).toEqual({ disabled: false, busy: false });
  });

  it('keeps the trailing button out of the tree where the row acts', () => {
    const root = renderRow({ row: integrationRow(), scope: 'personal' });

    const [button] = root.findAll(node => String(node.type) === 'Button');
    expect(button?.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(button?.props.accessible).toBe(false);
  });

  it('blocks a second mint while the launch is in flight', () => {
    const root = renderRow({ row: integrationRow(), scope: 'personal', connecting: true });

    const bodies = bodyPresses(root);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.props.disabled).toBe(true);
  });

  it('leaves an installed row inert so a body press cannot disconnect', () => {
    const root = renderRow({
      row: integrationRow({
        installed: true,
        accountLabel: 'octocat',
        disconnectIntegrationId: 'gh-1',
        canDisconnectNatively: true,
      }),
      scope: 'personal',
    });

    expect(bodyPresses(root)).toHaveLength(0);
    expect(root.findAllByType('RowMock')).toHaveLength(1);
  });

  it('wraps nothing while the connections read has not landed', () => {
    const root = renderRow({ row: integrationRow({ actionPending: true }), scope: 'personal' });

    expect(bodyPresses(root)).toHaveLength(0);
    expect(root.findAllByType('Skeleton')).toHaveLength(1);
  });
});
