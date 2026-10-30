/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns -- this module reads React's untyped private fiber fields on every dump; a schema parse per node would slow the gate's sampling loop */
import { type HostInstance, StyleSheet } from 'react-native';
// @ts-expect-error React Native exposes this measurement helper only as Flow source.
import { getBoundingClientRect } from 'react-native/src/private/webapis/dom/nodes/ReadOnlyElement';

type Rect = readonly [x: number, y: number, width: number, height: number];
export type Insets = Readonly<{ top: number; right: number; bottom: number; left: number }>;
export type Document = NonNullable<HostInstance['ownerDocument']>;
type Element = Document['documentElement'];
const measureLayout = getBoundingClientRect as (
  element: Element,
  options: { includeTransform: false }
) => Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>;
type Offset = Readonly<{ x: number; y: number }>;
const ZERO_OFFSET: Offset = { x: 0, y: 0 };

export type ProbeNode = Readonly<{
  parent: number;
  tag: string;
  rect: Rect;
  layoutRect: Rect;
  owners?: readonly string[];
  text?: string;
  testID?: string;
  label?: string;
  role?: string;
  pressable?: true;
  hitSlop?: Insets;
  lines?: number;
  screenState?: number;
  style?: Readonly<Record<string, string | number>>;
}>;

export const DESIGN_GATE_ANCHOR_ID = 'design-gate-anchor';

const ELEMENT_NODE = 1;
const COMPOSITE_TAGS = new Set([0, 1, 11, 14, 15]);
const OWNER_LIMIT = 6;
const PRESS_HANDLERS = ['onClick', 'onPress'] as const;
const STYLE_KEYS = [
  'alignItems',
  'alignSelf',
  'backgroundColor',
  'borderRadius',
  'borderWidth',
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'opacity',
  'overflow',
  'paddingBlock',
  'paddingBlockEnd',
  'paddingBlockStart',
  'paddingBottom',
  'paddingEnd',
  'paddingHorizontal',
  'paddingInline',
  'paddingInlineEnd',
  'paddingInlineStart',
  'paddingLeft',
  'paddingRight',
  'paddingStart',
  'paddingTop',
  'paddingVertical',
  'padding',
  'position',
] as const;

function field(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function compositeName(fiber: unknown): string | undefined {
  const type = field(fiber, 'type');
  const inner = field(type, 'render') ?? field(type, 'type');
  return (
    text(field(type, 'displayName')) ??
    text(field(type, 'name')) ??
    text(field(inner, 'displayName')) ??
    text(field(inner, 'name'))
  );
}

function owners(fiber: unknown): readonly string[] | undefined {
  const names: string[] = [];
  let current = field(fiber, 'return');
  while (current !== undefined && current !== null && names.length < OWNER_LIMIT) {
    const tag = field(current, 'tag');
    const name =
      typeof tag === 'number' && COMPOSITE_TAGS.has(tag) ? compositeName(current) : undefined;
    if (name !== undefined && names.at(-1) !== name) {
      names.push(name);
    }
    current = field(current, 'return');
  }
  return names.length > 0 ? names : undefined;
}

function insets(value: unknown): Insets | undefined {
  const all = finite(value);
  if (all !== undefined) {
    return { top: all, right: all, bottom: all, left: all };
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return {
    top: finite(field(value, 'top')) ?? 0,
    right: finite(field(value, 'right')) ?? 0,
    bottom: finite(field(value, 'bottom')) ?? 0,
    left: finite(field(value, 'left')) ?? 0,
  };
}

function layoutStyle(value: unknown): Readonly<Record<string, string | number>> | undefined {
  const flat: unknown = StyleSheet.flatten(value as Parameters<typeof StyleSheet.flatten>[0]);
  const picked: Record<string, string | number> = {};
  for (const key of STYLE_KEYS) {
    const entry = field(flat, key);
    if (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))) {
      picked[key] = entry;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function renderedText(tag: string, element: Element, props: unknown): string | undefined {
  if (tag === 'Paragraph' || tag === 'Text') {
    return text(element.textContent);
  }
  if (tag.endsWith('TextInput')) {
    return text(field(props, 'value')) ?? text(field(props, 'placeholder'));
  }
  return undefined;
}

function describe(element: Element, parent: number, viewport: Offset): ProbeNode {
  const box = element.getBoundingClientRect();
  const layout = measureLayout(element, { includeTransform: false });
  const fiber = field(element, '__internalInstanceHandle');
  const props = field(fiber, 'memoizedProps');
  const tag = element.tagName.replace(/^RN:/, '');
  const lines = finite(field(props, 'numberOfLines'));
  return {
    parent,
    tag,
    rect: [round(box.x), round(box.y), round(box.width), round(box.height)],
    layoutRect: [
      round(layout.x - viewport.x),
      round(layout.y - viewport.y),
      round(layout.width),
      round(layout.height),
    ],
    owners: owners(fiber),
    text: renderedText(tag, element, props),
    testID: text(field(props, 'testID')) ?? text(field(props, 'nativeID')),
    label: text(field(props, 'accessibilityLabel')) ?? text(field(props, 'aria-label')),
    role: text(field(props, 'accessibilityRole')) ?? text(field(props, 'role')),
    pressable: PRESS_HANDLERS.some(key => typeof field(props, key) === 'function')
      ? true
      : undefined,
    hitSlop: insets(field(props, 'hitSlop')),
    lines: lines !== undefined && lines > 0 ? lines : undefined,
    screenState: finite(field(props, 'activityState')),
    style: layoutStyle(field(props, 'style')),
  };
}

function elementChildren(element: Element): Element[] {
  const children: Element[] = [];
  for (const child of element.childNodes) {
    if (child.nodeType === ELEMENT_NODE && 'getBoundingClientRect' in child) {
      children.push(child as Element);
    }
  }
  return children;
}

/**
 * Every host element in depth-first pre-order. Both frames are surface-relative dp:
 * rect includes transforms; layoutRect excludes them. The probe anchor is omitted.
 */
export function collect(document: Document): ProbeNode[] {
  const nodes: ProbeNode[] = [];
  const root = document.documentElement;
  const visualRoot = root.getBoundingClientRect();
  const layoutRoot = measureLayout(root, { includeTransform: false });
  const viewport: Offset = { x: visualRoot.x - layoutRoot.x, y: visualRoot.y - layoutRoot.y };
  const pending: { element: Element; parent: number; viewport: Offset }[] = [
    { element: root, parent: -1, viewport },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const node = describe(
      next.element,
      next.parent,
      next.parent === -1 ? ZERO_OFFSET : next.viewport
    );
    if (node.testID !== DESIGN_GATE_ANCHOR_ID) {
      const index = nodes.length;
      nodes.push(node);
      // Native modal descendants form another RootNodeKind and exclude the outer viewport.
      const childViewport = node.tag === 'ModalHostView' ? ZERO_OFFSET : next.viewport;
      for (const child of elementChildren(next.element).toReversed()) {
        pending.push({ element: child, parent: index, viewport: childViewport });
      }
    }
  }
  return nodes;
}

type PressEvent = Readonly<{
  nativeEvent: Readonly<{
    locationX: number;
    locationY: number;
    pageX: number;
    pageY: number;
    timestamp: number;
  }>;
  persist: () => void;
  preventDefault: () => void;
  stopPropagation: () => void;
}>;

const PRESS_DEPTH = 12;
const ignore = (): void => undefined;

function matches(element: Element, query: string, exact: boolean): boolean {
  const props = field(field(element, '__internalInstanceHandle'), 'memoizedProps');
  const names = [
    text(field(props, 'testID')),
    text(field(props, 'nativeID')),
    text(field(props, 'accessibilityLabel')),
    text(field(props, 'aria-label')),
    renderedText(element.tagName.replace(/^RN:/, ''), element, props),
  ];
  return names.some(name => name !== undefined && (exact ? name === query : name.includes(query)));
}

// Exact matches first, then substring matches, each in document order.
function findAll(document: Document, query: string): Element[] {
  const found: Element[] = [];
  for (const exact of [true, false]) {
    const pending = [document.documentElement];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (matches(next, query, exact) && !found.includes(next)) {
        found.push(next);
      }
      pending.push(...elementChildren(next).toReversed());
    }
  }
  return found;
}

function pressHandler(element: Element): ((event: PressEvent) => void) | undefined {
  let fiber = field(element, '__internalInstanceHandle');
  for (let depth = 0; depth < PRESS_DEPTH && fiber !== undefined && fiber !== null; depth += 1) {
    const onPress = field(field(fiber, 'memoizedProps'), 'onPress');
    if (typeof onPress === 'function') {
      return onPress as (event: PressEvent) => void;
    }
    fiber = field(fiber, 'return');
  }
  return undefined;
}

/**
 * Calls the nearest `onPress` above the first element whose testID, label, or text
 * matches `query` and that sits in a pressable, as a tap there would. A match with no
 * press handler above it, such as the same words in a plain line, is skipped. The
 * native press feedback does not run; the handler and everything it starts do.
 */
export function pressElement(document: Document, query: string): string {
  const candidates = findAll(document, query);
  if (candidates.length === 0) {
    return 'not-found';
  }
  for (const element of candidates) {
    const handler = pressHandler(element);
    if (handler !== undefined) {
      const box = element.getBoundingClientRect();
      handler({
        nativeEvent: {
          locationX: box.width / 2,
          locationY: box.height / 2,
          pageX: box.x + box.width / 2,
          pageY: box.y + box.height / 2,
          timestamp: Date.now(),
        },
        persist: ignore,
        preventDefault: ignore,
        stopPropagation: ignore,
      });
      return `pressed ${element.tagName.replace(/^RN:/, '')} ${query}`;
    }
  }
  return 'not-pressable';
}
