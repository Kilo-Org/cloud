/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression tests. */

// An uninstalled row offers one control: the trailing cell's Connect text
// action. Four filled primary buttons on one screen read as four primary
// actions, which the layout contract allows one of, so the row keeps the
// action in its trailing cell and nothing else acts.

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TEXT_ACTION_PENDING_BAND_CLASS,
  TEXT_ACTION_SKELETON_CLASS,
} from '@/components/ui/row-trailing';
import {
  COMPACT_BUTTON_HIT_SLOP,
  tapTargetReachDp,
  textActionRowOverhangDp,
  textActionTargetClass,
  TOUCH_TARGET_DP,
  TOUCH_TARGET_OVERHANG_DP,
} from '@/lib/a11y/tap-target';
import { type IntegrationRow } from '@/lib/integrations/integration-rows';
import { type IntegrationScope } from '@/lib/integrations/provider-catalog';
import { compiledDimensions } from '@/test/native-dimensions';
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
  ConfigureRow: (props: { title?: string; trailing?: ReactNode; trailingIsTarget?: boolean }) =>
    createElement(
      'RowMock',
      { title: props.title, trailingIsTarget: props.trailingIsTarget },
      props.trailing ?? null
    ),
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

/** The shared `Button`'s `sm` size class list (`button.tsx`). */
const COMPACT_BUTTON_CLASS = 'min-h-[36px] rounded-md px-3 py-1.5';

/** The height a class list compiles to through the app's own theme, in dp. */
async function compiledBoxHeight(className: string): Promise<number | undefined> {
  type Box = { height?: number; minHeight?: number };
  const box = Object.assign({}, ...((await compiledDimensions(className)) as Box[])) as Box;
  return box.minHeight ?? box.height;
}

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
        onOpenOnWeb: calls.manageOnWeb,
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

/** The shared row the provider row rendered, before its trailing cell is unwrapped. */
function sharedRow(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const [row] = root.findAll(node => String(node.type) === 'RowMock');
  if (!row) {
    throw new Error('the provider row rendered no shared row');
  }
  return row;
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

  it('keeps the Connect cell inside the row frame the Disconnect row keeps', () => {
    // Field defect: the Connect row laid out at the action's 44pt target plus
    // the frame's padding, beside a sibling's two text lines, so the
    // Integrations group grew by the difference when a provider connected and
    // every row below it moved. The cell cancels the target's overhang the way
    // the switch does, so both rows lay out on the frame's one height.
    const [connect] = controls(renderRow({ row: integrationRow(), scope: 'personal' }));
    if (!connect) {
      throw new Error('the uninstalled row rendered no action');
    }
    const style: unknown = connect.props.style;
    if (typeof style !== 'object' || style === null) {
      throw new Error('the Connect cell carries no style');
    }
    const margin: unknown = 'marginVertical' in style ? style.marginVertical : undefined;
    if (typeof margin !== 'number') {
      throw new TypeError('the Connect cell carries no vertical margin');
    }

    // The box still carries the platform's target on its own node, and only the
    // margin it renders takes the overhang back out of the frame.
    expect(String(connect.props.className).split(' ')).toEqual(
      expect.arrayContaining(textActionTargetClass().split(' '))
    );
    expect(margin).toBe(-textActionRowOverhangDp());
    expect(TOUCH_TARGET_DP + 2 * margin).toBe(TOUCH_TARGET_DP - 2 * TOUCH_TARGET_OVERHANG_DP);
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

  it.each<[IntegrationScope, string | undefined, boolean, string]>([
    // Personal scope belongs to the viewer, so the settled row offers Disconnect:
    // the placeholder reserves that compact `sm` frame and marks the line.
    ['personal', undefined, true, TEXT_ACTION_SKELETON_CLASS],
    // A plain organization member may not disconnect, so every settled branch
    // resolves to no cell: the placeholder takes the row's 27pt content band.
    ['organization', 'member', false, TEXT_ACTION_PENDING_BAND_CLASS],
  ])(
    'holds the action cell while the connections read has not landed (%s)',
    async (scope, role, trailingIsTarget, skeletonClass) => {
      const root = renderRow({ row: integrationRow({ actionPending: true }), scope, role });

      expect(controls(root)).toHaveLength(0);
      expect(root.findAllByType('Skeleton')).toHaveLength(1);
      expect(root.findAllByType('Skeleton')[0]?.props.className).toBe(skeletonClass);
      // Compiled, not compared as a string: NativeWind's rem is 14pt, so `h-9`
      // would reserve 31.5pt. A cell that lands is the compact button, so its
      // placeholder holds that same height; a row that settles with no cell
      // holds the content band instead: `48 - 2 * 10.5 = 27pt`.
      expect(await compiledBoxHeight(skeletonClass)).toBe(
        trailingIsTarget ? await compiledBoxHeight(COMPACT_BUTTON_CLASS) : 27
      );
      // Only a row that will host a cell marks its stacked line: a stacked frame
      // hosts the cell at the target so Android delivers its reach.
      expect(sharedRow(root).props.trailingIsTarget).toBe(trailingIsTarget);
    }
  );

  it('gives the stacked row the host for its Connect cell too', () => {
    // A row that offers Connect uses the text-action variant, whose pressable
    // already carries the platform target (`textActionTargetClass`). A stacked
    // frame wraps every trailing cell in the row's 27pt line, so the cell needs
    // the same host the outline buttons take, or Android delivers its touches
    // through that band and the target it renders is unreachable.
    const root = renderRow({ row: integrationRow({ installed: false }), scope: 'personal' });

    expect(sharedRow(root).props.trailingIsTarget).toBe(true);
    const [connect] = controls(root);
    if (!connect) {
      throw new Error('the uninstalled row rendered no action');
    }
    expect(String(connect.props.className).split(' ')).toEqual(
      expect.arrayContaining(textActionTargetClass().split(' '))
    );
  });

  // The outline buttons keep the base's compact `sm` frame and reach the target
  // through the shared `Button`'s own `sm` `hitSlop` (5pt a side).
  it.each<{ name: string; row: Partial<IntegrationRow> }>([
    { name: 'manage on the web', row: { installed: true, webManaged: true } },
    {
      name: 'disconnect',
      row: {
        installed: true,
        accountLabel: 'octocat',
        disconnectIntegrationId: 'gh-1',
        canDisconnectNatively: true,
      },
    },
    {
      name: 'retry',
      row: { provider: 'bitbucket', installed: true, canDisconnectNatively: false },
    },
  ])('keeps the $name button compact and reaching the target by hitSlop', async ({ name, row }) => {
    const root = renderRow({
      row: integrationRow(row),
      scope: 'organization',
      role: 'owner',
    });
    const [button] = root.findAll(node => Object.is(node.type, 'Button'));
    if (!button) {
      throw new Error(`the ${name} row rendered no button`);
    }

    // Exactly as the shared `Button` renders `sm`: no height class of the row's
    // own and no margin cancel, so the cell stays label-sized.
    expect(button.props.size).toBe('sm');
    expect(button.props.className).toBeUndefined();
    expect(button.props.style).toBeUndefined();

    // The compiled compact frame plus the `hitSlop` every `sm` pressable gets.
    const reach = tapTargetReachDp(
      (await compiledBoxHeight(COMPACT_BUTTON_CLASS)) as number,
      COMPACT_BUTTON_HIT_SLOP.top
    );
    expect(reach).toBeGreaterThanOrEqual(TOUCH_TARGET_DP);

    // Without the mark a stacked frame delivers the touches through its band.
    expect(sharedRow(root).props.trailingIsTarget).toBe(true);
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
