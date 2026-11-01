/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { KiloCommandRowView } from '@/components/profiles/kilo-command-row';
import { act, TestRenderer } from '@/test/renderer';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Switch: 'Switch',
  Text: 'Text',
  View: 'View',
  useColorScheme: () => 'light',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    mutedForeground: '#666666',
    mutedSoft: '#eeeeee',
    primary: '#000000',
    primaryForeground: '#ffffff',
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Pencil: 'Pencil',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

type RowProps = Parameters<typeof KiloCommandRowView>[0];

const PROPS: RowProps = {
  name: 'review',
  description: '',
  template: 'Review the diff',
  subtask: false,
  agent: '',
  model: '',
  enabled: true,
  isFirst: false,
  isLast: false,
  onToggle: () => undefined,
  onMoveUp: () => undefined,
  onMoveDown: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
};

/**
 * A stored template as the row can receive it: a first line that opens with a
 * right-to-left override, then thousands of characters on later lines. The
 * server accepts up to 100,000 characters, so the row must not let one through.
 */
const FIRST_LINE = '\u202Efix the failing login test then explain the root cause in the summary';
const BODY = Array.from(
  { length: 340 },
  (_, index) => `body line ${index}: details the row never shows`
);
const LONG_TEMPLATE = [FIRST_LINE, ...BODY].join('\n');

/** The preview as the app's shared display helper bounds it: 40 characters with the ellipsis inside. */
const EXPECTED_PREVIEW = 'fix the failing login test then explain…';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(overrides: Partial<RowProps> = {}) {
  act(() => {
    const element = createElement(KiloCommandRowView, { ...PROPS, ...overrides });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KiloCommandRowView renderer');
  }
  return renderer.root;
}

/** Every text the mounted tree holds, in tree order: exactly what a screen reader walks. */
function accessibleTexts(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => Object.is(node.type, 'Text'))
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
}

/** The template preview node: the mono `text-xs` line under the command name. */
function previewNodes(root: TestRenderer.ReactTestInstance) {
  return root.findAll(node => {
    if (!Object.is(node.type, 'Text')) {
      return false;
    }
    const className = node.props.className;
    return (
      typeof className === 'string' &&
      className.includes('font-mono-medium') &&
      className.includes('text-xs')
    );
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('KiloCommandRowView template preview', () => {
  it('draws and exposes only the bounded first line of a multi-KB template', () => {
    const root = renderRow({ template: LONG_TEMPLATE });

    expect(LONG_TEMPLATE.length).toBeGreaterThan(3000);

    const previews = previewNodes(root);
    expect(previews).toHaveLength(1);
    const [preview] = previews;
    expect(preview?.children).toEqual([EXPECTED_PREVIEW]);
    expect(preview?.props.numberOfLines).toBe(1);
    // Android reads a text view without this prop from the string it holds, so
    // the bounded preview is the whole accessible label.
    expect(preview?.props.accessibilityLabel).toBeUndefined();

    // Nothing else carries the body: the template never reaches the native text view whole.
    const texts = accessibleTexts(root);
    expect(texts.filter(text => text.includes('body line'))).toEqual([]);
    expect(texts.every(text => text.length <= 40)).toBe(true);
  });

  it('keeps a short one-line template whole', () => {
    const root = renderRow({ template: 'Review the diff' });

    expect(previewNodes(root)[0]?.children).toEqual(['Review the diff']);
    expect(accessibleTexts(root).every(text => text.length <= 40)).toBe(true);
  });

  it('renders no preview for an empty or blank-only template', () => {
    for (const template of ['', '   ', '\n\n']) {
      const root = renderRow({ template });
      expect(previewNodes(root)).toEqual([]);
    }
  });

  it('keeps the switch and the row controls after the bounded preview', () => {
    const root = renderRow({ template: LONG_TEMPLATE });

    const [preview] = previewNodes(root);
    const [toggle] = root.findAll(node => Object.is(node.type, 'Switch'));
    const presses = root.findAll(node => Object.is(node.type, 'Pressable'));

    expect(toggle?.props.accessibilityLabel).toBe('/review');
    expect(presses.map(node => node.props.accessibilityLabel)).toEqual([
      'Move slash command review up',
      'Move slash command review down',
      'Edit slash command review',
      'Delete slash command review',
    ]);

    // Tree order is the reading order: the preview is bounded before the
    // controls that follow it are reached.
    const order = root.findAll(() => true);
    const positions = [preview, toggle, presses[0]].map(node =>
      node === undefined ? -1 : order.indexOf(node)
    );
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('paints the slash name and leaves the switch as the row stop that speaks it', () => {
    const root = renderRow();

    const nameLines = root.findAll(
      node => Object.is(node.type, 'Text') && node.children.includes('/review')
    );
    expect(nameLines).toHaveLength(1);
    expect(nameLines[0]?.props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });

    const [toggle] = root.findAll(node => Object.is(node.type, 'Switch'));
    // The announced name is the label on screen, slash included.
    expect(toggle?.props.accessibilityLabel).toBe('/review');
  });
});
