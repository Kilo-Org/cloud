/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ComponentProps, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** The row's outermost element, which carries the frame geometry. */
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

  it('passes hitSlop, onLayout, the hint and the caller name through', () => {
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
    expect(classesOf(title)).toContain('shrink');
    expect(textOf(root, 'this device')).toBeTruthy();
  });

  it('renders a plain subtitle line under the title', () => {
    const subtitle = textOf(
      renderFrame({ title: 'General', subtitle: { text: 'English' } }),
      'English'
    );

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
      subtitle: { text: 'Running' },
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
      subtitle: { text: 'Ready' },
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
