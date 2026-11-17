/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ComponentProps, type ComponentType, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LucideProps } from '@/components/ui/icons';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { act, TestRenderer } from '@/test/renderer';

import { ROW_FRAME_CLASS, ROW_FRAME_STACK_CLASS, RowFrame } from './row-frame';

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

/** The row's outermost element of a static row. */
function frameOf(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node => typeof node.props.className === 'string' && classesOf(node).includes('min-h-[48px]')
  );
}

function pressableOf(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(node => Object.is(node.type, 'Pressable'));
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

describe('RowFrame geometry', () => {
  it('owns the one row geometry', () => {
    const classes = classesOf(frameOf(renderFrame({ title: 'General' })));

    expect(classes).toEqual(
      expect.arrayContaining(['min-h-[48px]', 'flex-row', 'items-center', 'gap-3', 'px-4', 'py-3'])
    );
    expect(ROW_FRAME_CLASS.split(' ')).toEqual(
      expect.arrayContaining(['min-h-[48px]', 'px-4', 'py-3'])
    );
  });

  it('gives a static row no pressable and no interactive state', () => {
    const root = renderFrame({ title: 'General', testID: 'static-row' });

    expect(root.findAllByType('Pressable' as never)).toHaveLength(0);
    expect(root.findAll(node => node.props.accessibilityState !== undefined)).toHaveLength(0);
    expect(frameOf(root).props.testID).toBe('static-row');
  });

  it('stacks the leading cell above the text block when asked', () => {
    const classes = classesOf(frameOf(renderFrame({ title: 'General', stack: true })));

    expect(classes).toEqual(expect.arrayContaining(['min-h-[48px]', 'gap-2', 'px-4', 'py-3']));
    expect(classes).not.toContain('flex-row');
    expect(ROW_FRAME_STACK_CLASS).toContain('gap-2');
  });
});

describe('RowFrame interaction', () => {
  it('makes the whole row one button', () => {
    const onPress = vi.fn<() => void>();
    const root = renderFrame({ title: 'General', onPress, testID: 'row-1' });
    const row = pressableOf(root);

    act(() => {
      (row.props.onPress as () => void)();
    });

    expect(onPress).toHaveBeenCalledOnce();
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityState).toEqual({ disabled: false });
    expect(row.props.testID).toBe('row-1');
    expect(classesOf(row)).toContain('active:opacity-70');
  });

  it('takes a link role for a row that opens an outside destination', () => {
    const root = renderFrame({
      title: 'Advisory',
      onPress: () => undefined,
      accessibilityRole: 'link',
    });

    expect(pressableOf(root).props.accessibilityRole).toBe('link');
  });

  it('declares a disabled row inert and drops the pressed feedback', () => {
    const root = renderFrame({ title: 'General', onPress: () => undefined, disabled: true });
    const row = pressableOf(root);

    expect(row.props.disabled).toBe(true);
    expect(row.props.accessibilityState).toEqual({ disabled: true });
    expect(classesOf(row)).not.toContain('active:opacity-70');
  });

  it('passes hitSlop, onLayout and the caller name through', () => {
    const onLayout = vi.fn();
    const row = pressableOf(
      renderFrame({
        title: 'General',
        onPress: () => undefined,
        accessibilityLabel: 'Open general settings',
        accessibilityHint: 'Opens the language, theme and notification preferences',
        hitSlop: { top: 4, bottom: 4 },
        onLayout,
      })
    );

    expect(row.props.hitSlop).toEqual({ top: 4, bottom: 4 });
    expect(row.props.onLayout).toBe(onLayout);
    expect(row.props.accessibilityLabel).toBe('Open general settings');
    expect(row.props.accessibilityHint).toBe(
      'Opens the language, theme and notification preferences'
    );
  });

  it('presses only the content when a trailing control owns its own touch', () => {
    const root = renderFrame({
      title: 'Notifications',
      onPress: () => undefined,
      pressTarget: 'content',
      testID: 'pref-1',
      trailing: { kind: 'switch', value: true, onValueChange: () => undefined },
    });
    const frame = root.find(
      node =>
        Object.is(node.type, 'View') &&
        typeof node.props.testID === 'string' &&
        node.props.testID === 'pref-1'
    );
    const content = pressableOf(root);

    expect(Object.is(frame.type, 'View')).toBe(true);
    expect(classesOf(frame)).toEqual(expect.arrayContaining(['min-h-[48px]', 'px-4', 'py-3']));
    expect(content.props.accessible).toBe(false);
    expect(content.props.importantForAccessibility).toBe('no-hide-descendants');
    // The switch is the frame's child, not a child of the content press.
    expect(content.findAllByType('Switch' as never)).toHaveLength(0);
    expect(root.findAllByType('Switch' as never)).toHaveLength(1);
  });
});

describe('RowFrame text block', () => {
  it('keeps the title on one line with a tail ellipsis', () => {
    const title = textOf(renderFrame({ title: 'General' }), 'General');

    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.ellipsizeMode).toBe('tail');
    expect(classesOf(title)).toEqual(
      expect.arrayContaining(['text-sm', 'font-medium', 'text-foreground'])
    );
  });

  it('takes the caller title ink and a badge beside the title', () => {
    const root = renderFrame({
      title: 'Pixel 9',
      titleClassName: 'text-muted-foreground',
      titleBadge: createElement('Text', null, 'this device'),
    });
    const title = textOf(root, 'Pixel 9');

    expect(classesOf(title)).toContain('text-muted-foreground');
    expect(textOf(root, 'this device')).toBeTruthy();
    expect(classesOf(title)).toContain('shrink');
  });

  it('renders a plain subtitle on one tail-ellipsized line', () => {
    const subtitle = textOf(renderFrame({ title: 'General', subtitle: 'English' }), 'English');

    expect(subtitle.props.numberOfLines).toBe(1);
    expect(subtitle.props.ellipsizeMode).toBe('tail');
    expect(classesOf(subtitle)).toEqual(
      expect.arrayContaining(['mt-0.5', 'text-xs', 'text-muted-foreground'])
    );
  });

  it('takes the face and truncation a caller names for one line', () => {
    const subtitle = textOf(
      renderFrame({
        title: 'Session',
        subtitle: {
          text: 'abcdef0123456789',
          face: 'mono',
          numberOfLines: 2,
          ellipsizeMode: 'middle',
        },
      }),
      'abcdef0123456789'
    );

    expect(subtitle.props.variant).toBe('mono');
    expect(subtitle.props.numberOfLines).toBe(2);
    expect(subtitle.props.ellipsizeMode).toBe('middle');
  });

  it('renders a second subtitle line under the first', () => {
    const root = renderFrame({
      title: 'Session',
      subtitle: 'Running',
      secondSubtitle: { text: 'device-42', face: 'mono' },
    });

    expect(textOf(root, 'Running')).toBeTruthy();
    expect(textOf(root, 'device-42').props.variant).toBe('mono');
  });

  it('renders the placeholder in the subtitle slot until the text loads', () => {
    const root = renderFrame({
      title: 'Session',
      subtitlePlaceholder: createElement('Text', null, 'loading-subtitle'),
    });
    expect(textOf(root, 'loading-subtitle')).toBeTruthy();

    const loaded = renderFrame({
      title: 'Session',
      subtitle: 'Ready',
      subtitlePlaceholder: createElement('Text', null, 'loading-subtitle'),
    });
    expect(textOf(loaded, 'Ready')).toBeTruthy();
    expect(loaded.findAll(node => node.children.includes('loading-subtitle'))).toHaveLength(0);
  });

  it('renders caller content instead of the built text block', () => {
    const root = renderFrame({
      title: 'Ignored',
      children: createElement('Text', null, 'custom row content'),
    });

    expect(textOf(root, 'custom row content')).toBeTruthy();
    expect(root.findAll(node => node.children.includes('Ignored'))).toHaveLength(0);
  });
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
