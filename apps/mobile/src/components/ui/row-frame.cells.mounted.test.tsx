/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ComponentProps, type ComponentType, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LucideProps } from '@/components/ui/icons';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { act, TestRenderer } from '@/test/renderer';

import { RowFrame } from './row-frame';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icon-tile', () => ({ IconTile: 'IconTile' }));
vi.mock('@/components/ui/row-check', () => ({ RowCheck: 'RowCheck' }));
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#8A8680', foreground: '#111111' }),
}));

/** A Lucide-shaped icon component; the mocked tile never renders it. */
const Globe = (() => null) as unknown as ComponentType<LucideProps>;

type Props = ComponentProps<typeof RowFrame>;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderFrame(props: Props) {
  act(() => {
    const element = createElement(RowFrame, props);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing RowFrame renderer');
  }
  return renderer.root;
}

function classesOf(node: TestRenderer.ReactTestInstance): string[] {
  return String(node.props.className ?? '').split(' ');
}

function textOf(root: TestRenderer.ReactTestInstance, content: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(content));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('RowFrame leading cell', () => {
  it('renders an IconTile from the icon and its tint', () => {
    const tile = renderFrame({
      title: 'General',
      icon: Globe,
      iconTint: NEUTRAL_TINT,
    }).find(node => Object.is(node.type, 'IconTile'));

    expect(tile.props.icon).toBe(Globe);
    expect(tile.props.tint).toBe(NEUTRAL_TINT);
  });

  it('puts a busy node inside the tile it replaces', () => {
    const tile = renderFrame({
      title: 'General',
      icon: Globe,
      iconContent: createElement('Text', null, 'busy'),
    }).find(node => Object.is(node.type, 'IconTile'));

    expect(tile.props.icon).toBe(Globe);
    expect(tile.props.content).toBeTruthy();
  });

  it('takes any leading node, with no tile', () => {
    const root = renderFrame({
      title: 'Value',
      leading: createElement('Text', null, 'Label'),
    });

    expect(textOf(root, 'Label')).toBeTruthy();
    expect(root.findAllByType('IconTile' as never)).toHaveLength(0);
  });
});

describe('RowFrame trailing cell', () => {
  it('draws the chevron mark', () => {
    expect(
      renderFrame({ title: 'General', trailing: { kind: 'chevron' } }).findAllByType(
        'RowChevron' as never
      )
    ).toHaveLength(1);
  });

  it('draws the selection check with its state', () => {
    const check = renderFrame({
      title: 'Balanced',
      trailing: { kind: 'check', selected: true, disabled: true },
    }).find(node => Object.is(node.type, 'RowCheck'));

    expect(check.props.selected).toBe(true);
    expect(check.props.disabled).toBe(true);
  });

  it('draws a switch and carries its own test handle and state', () => {
    const toggle = renderFrame({
      title: 'Notifications',
      trailing: {
        kind: 'switch',
        value: true,
        onValueChange: () => undefined,
        testID: 'notifications-switch',
        accessibilityLabel: 'Notifications',
      },
    }).find(node => Object.is(node.type, 'Switch'));

    expect(toggle.props.value).toBe(true);
    expect(toggle.props.testID).toBe('notifications-switch');
    expect(toggle.props.accessibilityLabel).toBe('Notifications');
    expect(toggle.props.accessibilityState).toEqual({ disabled: false, checked: true });
  });

  it('paints a value that shrinks and truncates where the caller says', () => {
    const value = textOf(
      renderFrame({
        title: 'Repository',
        trailing: {
          kind: 'value',
          text: 'acme/api',
          face: 'mono',
          ellipsizeMode: 'tail',
        },
      }),
      'acme/api'
    );

    expect(value.props.variant).toBe('mono');
    expect(value.props.numberOfLines).toBe(1);
    expect(value.props.ellipsizeMode).toBe('tail');
    expect(classesOf(value)).toEqual(
      expect.arrayContaining(['min-w-0', 'shrink', 'text-right', 'text-[13px]'])
    );
  });

  it('holds a value at its natural width when it must not shrink', () => {
    const value = textOf(
      renderFrame({ title: 'Status', trailing: { kind: 'value', text: 'Ready', shrink: false } }),
      'Ready'
    );

    expect(classesOf(value)).toContain('shrink-0');
    expect(classesOf(value)).not.toContain('shrink');
  });

  it('keeps a status inside the value paragraph on its own ink', () => {
    const root = renderFrame({
      title: 'Plan',
      trailing: {
        kind: 'value',
        text: 'Teams',
        tone: 'default',
        status: { label: ' · Lapsed', tone: 'danger' },
      },
    });
    const value = textOf(root, 'Teams');
    const status = textOf(root, ' · Lapsed');

    expect(value.findAllByType('Text' as never)).toContain(status);
    expect(classesOf(value)).toContain('text-foreground');
    expect(classesOf(value)).not.toContain('text-destructive');
    expect(classesOf(status)).toEqual(expect.arrayContaining(['text-[13px]', 'text-destructive']));
  });

  it('draws a badge as a pill', () => {
    const root = renderFrame({
      title: 'Pixel 9',
      trailing: { kind: 'badge', label: 'This device' },
    });
    const label = textOf(root, 'This device');
    const pill = label.parent;
    if (pill === null) {
      throw new Error('The badge pill is missing');
    }

    expect(classesOf(pill)).toEqual(expect.arrayContaining(['rounded-full', 'px-2', 'py-0.5']));
    expect(label.props.variant).toBe('caption');
  });

  it('draws a text action as its own button', () => {
    const onPress = vi.fn<() => void>();
    const action = renderFrame({
      title: 'Device sessions',
      trailing: { kind: 'action', label: 'Sign out all', onPress },
    }).find(
      node => Object.is(node.type, 'Pressable') && node.props.accessibilityLabel === 'Sign out all'
    );

    act(() => {
      (action.props.onPress as () => void)();
    });

    expect(onPress).toHaveBeenCalledOnce();
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityState).toEqual({ disabled: false });
    expect(classesOf(action).some(name => name.startsWith('min-h-'))).toBe(true);
  });

  it('renders a wrapper-built node as-is', () => {
    const root = renderFrame({
      title: 'Billable',
      trailing: { kind: 'node', node: createElement('Text', null, '0.0041') },
    });

    expect(textOf(root, '0.0041')).toBeTruthy();
  });

  it('groups several trailing nodes on one line', () => {
    const root = renderFrame({
      title: 'Host',
      trailing: {
        kind: 'nodes',
        nodes: [createElement('Text', null, 'edit'), createElement('Text', null, 'delete')],
      },
    });
    const group = root.find(
      node =>
        Object.is(node.type, 'View') &&
        classesOf(node).includes('gap-2') &&
        classesOf(node).includes('flex-row')
    );

    expect(classesOf(group)).toContain('shrink-0');
    expect(textOf(root, 'edit')).toBeTruthy();
    expect(textOf(root, 'delete')).toBeTruthy();
  });
});
