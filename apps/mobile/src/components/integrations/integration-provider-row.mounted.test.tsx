/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression tests. */

// An uninstalled row offers one control: the trailing cell's Connect text
// action. Four filled primary buttons on one screen read as four primary
// actions, which the layout contract allows one of, so the row keeps the
// action in its trailing cell and nothing else acts.
//
// Installed and pending rows stay inert: their action is destructive, or not
// known yet.

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
  retryConnection: vi.fn<() => void>(),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Switch: 'Switch',
  View: 'View',
  useColorScheme: () => 'light',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));
// The shared row is a host element here; its trailing cell is the only control
// the row renders, so the suite reads the cell rather than the row.
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string; trailing?: ReactNode }) =>
    createElement('RowMock', { title: props.title }, props.trailing ?? null),
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
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
  retryingConnection?: boolean;
}): TestRenderer.ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(
      createElement(IntegrationProviderRow, {
        row: props.row,
        scope: props.scope,
        role: props.role,
        connecting: props.connecting ?? false,
        disconnecting: false,
        retryingConnection: props.retryingConnection ?? false,
        onConnect: calls.connect,
        onDisconnect: calls.disconnect,
        onManageOnWeb: calls.manageOnWeb,
        onRetryConnection: calls.retryConnection,
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

/** Every control the row renders, found by the handler it carries. */
function controls(root: TestRenderer.ReactTestInstance) {
  return root.findAll(node => typeof node.props.onPress === 'function');
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

describe('IntegrationProviderRow action cell', () => {
  it.each([
    { scope: 'personal' as const, role: undefined },
    { scope: 'organization' as const, role: 'owner' },
  ])('connects from the one trailing action of an uninstalled $scope row', ({ scope, role }) => {
    const root = renderRow({ row: integrationRow(), scope, role });

    const rows = controls(root);
    expect(rows).toHaveLength(1);
    const [connect] = rows;
    if (!connect) {
      throw new Error('the uninstalled row rendered no action');
    }
    press(connect);

    expect(calls.connect).toHaveBeenCalledOnce();
    expect(calls.disconnect).not.toHaveBeenCalled();
    expect(calls.manageOnWeb).not.toHaveBeenCalled();
  });

  it('names the trailing action after the provider it connects', () => {
    const root = renderRow({ row: integrationRow(), scope: 'personal' });

    const [connect] = controls(root);
    expect(connect?.props.accessibilityLabel).toBe('Connect. GitHub');
    expect(connect?.props.accessibilityRole).toBe('button');
  });

  it('carries the Connect label in the row cell', () => {
    const root = renderRow({ row: integrationRow(), scope: 'personal' });

    expect(root.findAllByType('TextMock').map(node => node.props.children)).toContain('Connect');
  });

  it('keeps the Connect control named and busy while the launch is in flight', () => {
    // A bare spinner in the cell dropped the control's name, so the row went
    // silent while it refused taps. The cell keeps the action and announces
    // the wait; its label stays on screen.
    const root = renderRow({ row: integrationRow(), scope: 'personal', connecting: true });

    const [connect] = controls(root);
    expect(connect?.props.accessibilityLabel).toBe('Connect. GitHub');
    expect(connect?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(root.findAllByType('TextMock').map(node => node.props.children)).toContain('Connect');
  });

  it('leaves an installed row inert so a stray press cannot disconnect', () => {
    const root = renderRow({
      row: integrationRow({
        installed: true,
        accountLabel: 'octocat',
        disconnectIntegrationId: 'gh-1',
        canDisconnectNatively: true,
      }),
      scope: 'personal',
    });

    const [disconnect] = controls(root);
    expect(disconnect?.props.accessibilityLabel).toBe('Disconnect. GitHub');
    expect(calls.connect).not.toHaveBeenCalled();
  });

  it('holds the action cell while the connections read has not landed', () => {
    const root = renderRow({ row: integrationRow({ actionPending: true }), scope: 'personal' });

    expect(controls(root)).toHaveLength(0);
    expect(root.findAllByType('Skeleton')).toHaveLength(1);
  });

  it('offers the failed connection read again on an installed row it cannot name', () => {
    // Bitbucket reads its integration separately from the setup status, so a
    // failed read leaves an installed row with no connection to disconnect:
    // the row repeats that read instead of falling silent.
    const root = renderRow({
      row: integrationRow({
        provider: 'bitbucket',
        installed: true,
        accountLabel: 'acme-workspace',
        disconnectIntegrationId: null,
        canDisconnectNatively: false,
        webManaged: false,
      }),
      scope: 'organization',
      role: 'owner',
    });

    const [retry] = root.findAll(node => String(node.type) === 'Button');
    if (!retry) {
      throw new Error('the unnamed row rendered no retry');
    }
    expect(retry.props.accessibilityLabel).toBe('Retry. Bitbucket');
    expect(retry.props.loading).toBe(false);
    press(retry);
    expect(calls.retryConnection).toHaveBeenCalledOnce();
  });

  it('draws the retried connection read as busy', () => {
    const root = renderRow({
      row: integrationRow({
        provider: 'bitbucket',
        installed: true,
        canDisconnectNatively: false,
        webManaged: false,
      }),
      scope: 'organization',
      role: 'owner',
      retryingConnection: true,
    });

    const [retry] = root.findAll(node => String(node.type) === 'Button');
    expect(retry?.props.loading).toBe(true);
  });
});
