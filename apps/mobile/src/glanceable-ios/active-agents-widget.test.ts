/* eslint-disable max-lines -- one suite per Home family and state, sharing the swift-ui recording harness and the vertical layout model */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { buildHomeWidgetData, type HomeWidgetSessionRow } from '@kilocode/app-shared/home-widget';

import { type GlanceableActionFeedback, setSurfaceExtras } from '@/lib/glanceable/surface-extras';

import { type WidgetFamily } from 'expo-widgets';

import { activeAgentsWidgetLayout } from './active-agents-widget';
import { buildGlanceableViewProps, type GlanceableWidgetProps } from './view-props';

/** A swift-ui primitive stand-in: the kind tag rides on the function itself. */
function mockComponent(kind: string) {
  return Object.assign((props: Record<string, unknown>) => ({ kind, props }), { kind });
}

/** A recording swift-ui modifier stub. */
function mockModifier(name: string) {
  return (args?: unknown) => ({ $type: name, args });
}

vi.mock('expo-widgets', () => ({ createWidget: () => ({}), widgetsDirectory: '' }));
vi.mock('@expo/ui/swift-ui', () => ({
  AccessoryWidgetBackground: mockComponent('AccessoryWidgetBackground'),
  Button: mockComponent('Button'),
  Circle: mockComponent('Circle'),
  HStack: mockComponent('HStack'),
  Image: mockComponent('Image'),
  Rectangle: mockComponent('Rectangle'),
  RoundedRectangle: mockComponent('RoundedRectangle'),
  Spacer: mockComponent('Spacer'),
  Text: mockComponent('Text'),
  VStack: mockComponent('VStack'),
  ZStack: mockComponent('ZStack'),
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: mockModifier('accessibilityElement'),
  accessibilityLabel: mockModifier('accessibilityLabel'),
  aspectRatio: mockModifier('aspectRatio'),
  background: (style: unknown, shape?: unknown) => ({
    $type: 'background',
    args: { style, shape },
  }),
  buttonStyle: mockModifier('buttonStyle'),
  cornerRadius: mockModifier('cornerRadius'),
  containerBackground: (style: unknown) => ({ $type: 'containerBackground', args: style }),
  environment: mockModifier('environment'),
  fixedSize: mockModifier('fixedSize'),
  font: mockModifier('font'),
  foregroundStyle: mockModifier('foregroundStyle'),
  frame: mockModifier('frame'),
  layoutPriority: mockModifier('layoutPriority'),
  lineLimit: mockModifier('lineLimit'),
  monospacedDigit: mockModifier('monospacedDigit'),
  multilineTextAlignment: mockModifier('multilineTextAlignment'),
  opacity: mockModifier('opacity'),
  padding: mockModifier('padding'),
  resizable: mockModifier('resizable'),
  shapes: {
    capsule: () => ({ shape: 'capsule' }),
    circle: () => ({ shape: 'circle' }),
    roundedRectangle: (params: object) => ({ shape: 'roundedRectangle', ...params }),
  },
  widgetURL: mockModifier('widgetURL'),
}));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));

afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

const NOW = 1_750_000_000_000;
const MINUTE = 60_000;
const APPROVAL_KEY = 'a'.repeat(64);
const ENGLISH: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
  'common.idle': 'Idle',
};
const translate = (key: string) => ENGLISH[key] ?? key;

type Options = {
  feedback?: GlanceableActionFeedback;
  status?: 'waiting' | 'empty' | 'signed_out' | 'privacy' | 'stale';
  now?: number;
};

function propsFor(sessions: HomeWidgetSessionRow[], options: Options = {}): GlanceableWidgetProps {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: options.feedback ?? null });
  const input = {
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    ...(options.status === undefined ? {} : { status: options.status }),
  };
  const snapshot = buildGlanceableSnapshot(input);
  const flags = options.status === 'signed_out' ? { signedOut: true } : {};
  return buildGlanceableViewProps(
    snapshot,
    flags,
    translate,
    buildHomeWidgetData(input),
    options.now ?? NOW
  );
}

type Rendered = { kind: string; props: Record<string, unknown> };
type Modifier = { $type: string; args: Record<string, unknown> | undefined };

function render(
  props: GlanceableWidgetProps,
  family: WidgetFamily,
  {
    colorScheme = 'light',
    at = NOW,
    renderingMode = 'fullColor',
  }: {
    colorScheme?: 'light' | 'dark';
    at?: number;
    renderingMode?: 'fullColor' | 'accented' | 'vibrant';
  } = {}
): Rendered {
  return activeAgentsWidgetLayout(props, {
    widgetFamily: family,
    date: new Date(at),
    colorScheme,
    widgetRenderingMode: renderingMode,
    configuration: undefined,
  }) as unknown as Rendered;
}

function element(node: unknown): Rendered | null {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) {
    return null;
  }
  const { type, props } = node;
  if (
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
    typeof type !== 'function' ||
    !('kind' in type) ||
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
    typeof type.kind !== 'string' ||
    props === null ||
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
    typeof props !== 'object'
  ) {
    return null;
  }
  // A JSX element's props object; every reader below narrows the field it uses.
  const record = props as Record<string, unknown>;
  return { kind: type.kind, props: record };
}

function children(node: Rendered | undefined): Rendered[] {
  const raw = node?.props.children;
  return (Array.isArray(raw) ? raw.flat(Infinity) : [raw])
    .map(child => element(child))
    .filter((child): child is Rendered => child !== null);
}

function collect(node: Rendered): Rendered[] {
  return [node, ...children(node).flatMap(child => collect(child))];
}

function texts(tree: Rendered): string[] {
  return collect(tree)
    .filter(node => node.kind === 'Text' && typeof node.props.children === 'string')
    .map(node => node.props.children as string);
}

function modifiers(node: Rendered | undefined): Modifier[] {
  return Array.isArray(node?.props.modifiers) ? (node.props.modifiers as Modifier[]) : [];
}

function modifier(node: Rendered | undefined, type: string): Record<string, unknown> | undefined {
  return modifiers(node).find(entry => entry.$type === type)?.args;
}

function textNode(tree: Rendered, value: string): Rendered | undefined {
  return collect(tree).find(node => node.kind === 'Text' && node.props.children === value);
}

function buttons(tree: Rendered): Record<string, unknown>[] {
  return collect(tree)
    .filter(node => node.kind === 'Button' && typeof node.props.onPress === 'function')
    .map(node => (node.props.onPress as () => Record<string, unknown>)());
}

// ── a vertical layout model ─────────────────────────────────────────────────
// SwiftUI's line box for SF Pro is 1.193em with the baseline 0.952em down. The
// model stacks the rendered tree the way the stacks lay it out at the design's
// reference heights, so each test can read where a baseline lands.

const SIZE: Record<string, [number, number]> = {
  systemSmall: [170, 170],
  systemMedium: [364, 170],
  systemLarge: [364, 382],
};

type Baseline = { text: string; baseline: number };

function fontSize(node: Rendered | undefined): number {
  return (modifier(node, 'font')?.size as number | undefined) ?? 17;
}

function fixedHeight(node: Rendered): number | undefined {
  const frames = modifiers(node).filter(entry => entry.$type === 'frame');
  for (const frame of frames.toReversed()) {
    if (typeof frame.args?.height === 'number') {
      return frame.args.height;
    }
  }
  return undefined;
}

function isFill(node: Rendered): boolean {
  return node.kind === 'Spacer' && modifiers(node).every(entry => entry.$type !== 'frame');
}

function place(node: Rendered, top: number, out: Baseline[]): number {
  const offset = (modifier(node, 'padding')?.top as number | undefined) ?? 0;
  const start = top + offset;
  const fixed = fixedHeight(node);
  let height = 0;
  if (node.kind === 'Text') {
    const size = fontSize(node);
    height = 1.193 * size;
    const label =
      typeof node.props.children === 'string'
        ? node.props.children
        : `<${String(node.props.dateStyle)}>`;
    out.push({ text: label, baseline: start + ((fixed ?? height) - height) / 2 + 0.952 * size });
  } else if (node.kind === 'Spacer') {
    height = (modifier(node, 'frame')?.maxHeight as number | undefined) ?? 0;
  } else if (node.kind === 'VStack') {
    const spacing = typeof node.props.spacing === 'number' ? node.props.spacing : 0;
    let y = start;
    for (const [index, child] of children(node).entries()) {
      const before = index === 0 ? 0 : spacing;
      y += before + place(child, y + before, out);
    }
    height = y - start;
  } else if (node.kind === 'HStack' || node.kind === 'ZStack' || node.kind === 'Button') {
    const parts = children(node);
    const heights = parts.map(child => place(child, 0, []));
    height = Math.max(0, ...heights);
    const box = fixed ?? height;
    for (const [index, child] of parts.entries()) {
      const aligned = node.props.alignment === 'top' ? 0 : (box - (heights[index] ?? 0)) / 2;
      place(child, start + aligned, out);
    }
  }
  return offset + (fixed ?? height);
}

/** Baselines of every text in a Home card at the design's reference size. */
function baselines(tree: Rendered, family: WidgetFamily): Baseline[] {
  const [, height] = SIZE[family] ?? [0, 0];
  const top = 16;
  const bottom = height - 16;
  const segments: Rendered[][] = [[]];
  for (const child of children(tree)) {
    if (isFill(child)) {
      segments.push([]);
    } else {
      segments.at(-1)?.push(child);
    }
  }
  const out: Baseline[] = [];
  const measure = (nodes: Rendered[]) => nodes.reduce((sum, node) => sum + place(node, 0, []), 0);
  const stack = (nodes: Rendered[], from: number) =>
    nodes.reduce((y, node) => y + place(node, y, out), from);
  const head = segments[0] ?? [];
  const headEnd = stack(head, top);
  if (segments.length === 1) {
    return out;
  }
  const tail = segments.at(-1) ?? [];
  const tailStart = bottom - measure(tail);
  stack(tail, tailStart);
  for (const middle of segments.slice(1, -1)) {
    stack(middle, headEnd + (tailStart - headEnd - measure(middle)) / 2);
  }
  return out;
}

const TOLERANCE = 0.75;

function expectBaselines(tree: Rendered, family: WidgetFamily, expected: [string, number][]) {
  const placed = baselines(tree, family);
  for (const [text, baseline] of expected) {
    const match = placed.find(entry => entry.text === text);
    expect(match, `${family}: "${text}" placed`).toBeDefined();
    expect(
      Math.abs((match?.baseline ?? 0) - baseline),
      `${family}: "${text}" at ${match?.baseline} vs ${baseline}`
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

const PERMISSION: HomeWidgetSessionRow = {
  status: 'permission',
  title: 'Migrate the billing webhooks',
  approvalKey: APPROVAL_KEY,
  statusUpdatedAt: new Date(NOW - 10 * MINUTE).toISOString(),
};
const QUESTION: HomeWidgetSessionRow = {
  status: 'question',
  title: 'Pick a color for the badge',
  statusUpdatedAt: new Date(NOW - 5 * MINUTE).toISOString(),
};
const RETRY: HomeWidgetSessionRow = {
  status: 'retry',
  title: 'Recover the interrupted build',
  statusUpdatedAt: new Date(NOW - 4 * MINUTE).toISOString(),
};
const BUSY: HomeWidgetSessionRow = { status: 'busy', title: 'Fix the flaky login test' };
const IDLE: HomeWidgetSessionRow = { status: 'idle', title: 'Review the onboarding copy' };
const scheduled = (title: string, at: number | null): HomeWidgetSessionRow => ({
  status: 'scheduled',
  title,
  ...(at === null ? {} : { scheduledAt: new Date(at).toISOString() }),
});
const HOME_FAMILIES: WidgetFamily[] = ['systemSmall', 'systemMedium', 'systemLarge'];
const ACCESSORY_FAMILIES: WidgetFamily[] = [
  'accessoryCircular',
  'accessoryInline',
  'accessoryRectangular',
];

describe('Home header', () => {
  const STATES = [
    propsFor([PERMISSION, BUSY]),
    propsFor([BUSY]),
    propsFor([], { status: 'empty' }),
    propsFor([], { status: 'waiting' }),
    propsFor([], { status: 'privacy' }),
    propsFor([], { status: 'signed_out' }),
  ];

  it.each(HOME_FAMILIES)('draws the Kilo mark, Kilo, and a fixed trailing + slot in %s', family => {
    for (const props of STATES) {
      const header = children(render(props, family))[0];
      if (header === undefined) {
        throw new Error('no header');
      }
      expect(fixedHeight(header)).toBe(24);
      const parts = children(header);
      // The real mark in a fixed 18pt slot, never a drawn tile.
      expect(modifier(parts[0], 'frame')).toEqual({ width: 18, height: 18 });
      expect(children(parts[0])[0]?.props.uiImage).toBe('__KILO_WIDGET_LOGO_URI__');
      expect(parts[1]?.props.children).toBe('Kilo');
      // `+` always owns the last 24pt slot, so a hidden action never moves it.
      expect(modifier(parts.at(-1), 'frame')).toEqual({ width: 24, height: 24 });
      // The Approve slot ends 4pt before `+`, pill and circle alike.
      expect(modifier(parts.at(-2), 'padding')).toEqual({ trailing: 4 });
    }
  });

  it.each(HOME_FAMILIES)('keeps an equal 16pt band on all four sides in %s', family => {
    for (const props of STATES) {
      expect(modifier(render(props, family), 'padding')).toEqual({
        top: 16,
        bottom: 16,
        leading: 16,
        trailing: 16,
      });
    }
  });

  it.each(['accented', 'vibrant'] as const)(
    'draws the glyph template and see-through action fills when %s',
    renderingMode => {
      const tree = render(propsFor([PERMISSION, BUSY]), 'systemMedium', { renderingMode });
      const header = children(tree)[0];
      expect(children(children(header)[0])[0]?.props.uiImage).toBe('__KILO_WIDGET_GLYPH_URI__');
      const fills = collect(header ?? tree)
        .map(node => modifier(node, 'background')?.style)
        .filter(style => style !== undefined);
      expect(fills.length).toBeGreaterThan(0);
      // The foreground at 22% alpha, so the glyph on top stays visible.
      for (const style of fills) {
        expect(style).toBe('#14130F38');
      }
    }
  );

  it.each([...HOME_FAMILIES, ...ACCESSORY_FAMILIES])(
    'lays %s out in leading and trailing terms only, so RTL mirrors it',
    family => {
      for (const props of STATES) {
        for (const node of collect(render(props, family))) {
          expect(JSON.stringify(node.props.alignment ?? '')).not.toMatch(/left|right/i);
          for (const entry of modifiers(node)) {
            expect(entry.$type).not.toBe('offset');
            expect(Object.keys(entry.args ?? {}).join(',')).not.toMatch(/left|right|\bx\b/i);
            expect(JSON.stringify(entry.args?.alignment ?? '')).not.toMatch(/left|right/i);
          }
        }
      }
    }
  );

  it('paints the approved light and dark palettes', () => {
    const background = (scheme: 'light' | 'dark') =>
      modifier(
        render(propsFor([BUSY]), 'systemSmall', { colorScheme: scheme }),
        'containerBackground'
      );
    expect(background('light')).toBe('#FBFAF5');
    expect(background('dark')).toBe('#17171A');
    const dot = (rows: HomeWidgetSessionRow[]) =>
      collect(render(propsFor(rows), 'systemSmall')).find(node => node.kind === 'Circle');
    expect(modifier(dot([PERMISSION]), 'foregroundStyle')).toBe('#956011');
    expect(modifier(dot([BUSY]), 'foregroundStyle')).toBe('#24784A');
    expect(modifier(dot([scheduled('Usage report', null)]), 'foregroundStyle')).toBe('#2260EB');
    expect(modifier(dot([IDLE]), 'foregroundStyle')).toBe('#A9A39A');
  });
});

describe('needs input', () => {
  it('places the small card per round 2', () => {
    const tree = render(propsFor([PERMISSION, QUESTION]), 'systemSmall');
    expectBaselines(tree, 'systemSmall', [
      ['2', 82],
      ['Needs input', 102],
      ['Migrate the billing webhooks', 121],
      ['Checked', 151],
    ]);
    expect(buttons(tree)).toContainEqual(
      expect.objectContaining({ pendingAction: 'approve', pendingApprovalKey: APPROVAL_KEY })
    );
  });

  it('places the medium card with two waiting rows', () => {
    const tree = render(propsFor([PERMISSION, QUESTION, RETRY]), 'systemMedium');
    expectBaselines(tree, 'systemMedium', [
      ['3', 92],
      ['Needs input', 112],
      ['Migrate the billing webhooks', 74],
      ['Permission required', 90],
      ['Pick a color for the badge', 116],
      ['Answer needed', 132],
      ['Checked', 151],
    ]);
    expect(texts(tree)).not.toContain('Recover the interrupted build');
    expect(texts(tree)).toContain('Approve');
  });

  it('places the large card with counts, Waiting for you, and three rows', () => {
    const tree = render(
      propsFor([PERMISSION, QUESTION, RETRY, BUSY, IDLE, scheduled('Usage report', null)]),
      'systemLarge'
    );
    expectBaselines(tree, 'systemLarge', [
      ['3', 106],
      ['Needs input', 131],
      ['1 Working', 74],
      ['1 Scheduled', 96],
      ['1 Idle', 118],
      ['Waiting for you', 176],
      ['Migrate the billing webhooks', 202],
      ['Permission required', 219],
      ['Pick a color for the badge', 248],
      ['Recover the interrupted build', 294],
      ['Waiting to retry', 311],
      ['Checked', 363],
    ]);
  });

  it.each(HOME_FAMILIES)('offers no Approve for a question or retry in %s', family => {
    const tree = render(propsFor([QUESTION, RETRY]), family);
    expect(buttons(tree).some(press => press.pendingAction === 'approve')).toBe(false);
    expect(buttons(tree)).toContainEqual(expect.objectContaining({ pendingAction: 'new-agent' }));
  });

  it.each(HOME_FAMILIES)('shows Approving… in the Approve slot without a button in %s', family => {
    const tree = render(propsFor([PERMISSION], { feedback: 'approving' }), family);
    expect(buttons(tree).some(press => press.pendingAction === 'approve')).toBe(false);
    if (family === 'systemSmall') {
      expect(collect(tree).some(node => node.props.systemName === 'ellipsis')).toBe(true);
    } else {
      expect(texts(tree)).toContain('Approving…');
    }
  });

  it.each(HOME_FAMILIES)('keeps Approve and says it failed in %s', family => {
    const tree = render(propsFor([PERMISSION], { feedback: 'couldNotApprove' }), family);
    expect(buttons(tree)).toContainEqual(expect.objectContaining({ pendingAction: 'approve' }));
    if (family === 'systemSmall') {
      // The failure replaces the detail line; the footer keeps the checked time.
      expectBaselines(tree, family, [
        ['Could not approve', 121],
        ['Checked', 151],
      ]);
    } else {
      // The failure replaces the footer.
      const footer = "Couldn't approve. Tap Approve to try again.";
      expectBaselines(tree, family, [[footer, family === 'systemLarge' ? 363 : 151]]);
      expect(texts(tree)).not.toContain('Checked');
      expect(modifier(textNode(tree, footer), 'foregroundStyle')).toBe('#956011');
    }
  });
});

describe('working, idle, mixed', () => {
  it('names the newest working agent under the count in small', () => {
    expectBaselines(render(propsFor([BUSY]), 'systemSmall'), 'systemSmall', [
      ['1', 82],
      ['Working', 102],
      ['Fix the flaky login test', 121],
    ]);
  });

  it('prints Recent and the title in the medium column when nothing else counts', () => {
    expectBaselines(render(propsFor([IDLE]), 'systemMedium'), 'systemMedium', [
      ['1', 92],
      ['Idle', 112],
      ['Recent', 88],
      ['Review the onboarding copy', 106],
    ]);
  });

  it('lists the other counts in the medium column when mixed', () => {
    const tree = render(propsFor([BUSY, IDLE, scheduled('Usage report', null)]), 'systemMedium');
    expectBaselines(tree, 'systemMedium', [
      ['1 Scheduled', 78],
      ['1 Idle', 102],
    ]);
    expect(texts(tree)).not.toContain('Recent');
  });

  it('sizes the one-kind large count to 88pt with Recent below the rule', () => {
    const tree = render(propsFor([BUSY]), 'systemLarge');
    expectBaselines(tree, 'systemLarge', [
      ['1', 168],
      ['Working', 203],
      ['Recent', 268],
      ['Fix the flaky login test', 292],
      ['Checked', 363],
    ]);
    expect(fontSize(textNode(tree, '1'))).toBe(88);
  });

  it('places the mixed large card with Next scheduled', () => {
    const tree = render(
      propsFor([BUSY, IDLE, scheduled('Usage report', NOW + 60 * MINUTE)]),
      'systemLarge'
    );
    expectBaselines(tree, 'systemLarge', [
      ['1', 120],
      ['Working', 145],
      ['1 Scheduled', 92],
      ['1 Idle', 116],
      ['Recent', 210],
      ['Fix the flaky login test', 234],
      ['Next scheduled', 284],
      ['Usage report', 308],
      ['<time>', 326],
    ]);
  });
});

describe('scheduled', () => {
  const later = (days: number) => NOW + days * 24 * 60 * MINUTE;

  it('prints Next run and today’s clock time in small and the rows in medium', () => {
    const rows = [
      scheduled('Usage report', NOW + 90 * MINUTE),
      scheduled('Audit', NOW + 120 * MINUTE),
    ];
    const small = render(propsFor(rows), 'systemSmall');
    expectBaselines(small, 'systemSmall', [
      ['Scheduled', 102],
      ['Next run', 121],
    ]);
    expect(collect(small).some(node => node.props.dateStyle === 'time')).toBe(true);
    expectBaselines(render(propsFor(rows), 'systemMedium'), 'systemMedium', [
      ['Usage report', 74],
      ['Audit', 116],
    ]);
  });

  it('adds a locale date on a later day, with no Today or Tomorrow word', () => {
    const tree = render(propsFor([scheduled('Dependency audit', later(3))]), 'systemMedium');
    const line = texts(tree).find(text => /\d/.test(text) && text !== '1');
    expect(line).toMatch(/\d{1,2}:\d{2}/);
    expect(texts(tree).join(' ')).not.toMatch(/Today|Tomorrow|ago/);
  });

  it('marks a passed wake Awaiting update in muted copy', () => {
    const props = propsFor([scheduled('Dependency audit', NOW + MINUTE)], {
      now: NOW + 2 * MINUTE,
    });
    for (const family of HOME_FAMILIES) {
      const tree = render(props, family, { at: NOW + 2 * MINUTE });
      const awaiting = textNode(tree, 'Awaiting update');
      expect(awaiting, family).toBeDefined();
      expect(modifier(awaiting, 'foregroundStyle')).toBe('#6F6A61');
      expect(texts(tree)).not.toContain('Working');
    }
  });

  it('shows nothing for an unknown time: the title in small, no detail in the rows', () => {
    const rows = [scheduled('Dependency audit', null), scheduled('Usage report', null)];
    expectBaselines(render(propsFor(rows), 'systemSmall'), 'systemSmall', [
      ['Dependency audit', 121],
    ]);
    const medium = render(propsFor(rows), 'systemMedium');
    // The rows keep their pitch with an empty detail slot.
    expectBaselines(medium, 'systemMedium', [
      ['Dependency audit', 74],
      ['Usage report', 116],
    ]);
    expect(texts(medium)).not.toContain('Awaiting update');
  });

  it('places the large scheduled card per round 4', () => {
    const tree = render(
      propsFor([
        scheduled('Usage report', NOW + 60 * MINUTE),
        scheduled('Dependency audit', NOW + 120 * MINUTE),
        scheduled('Weekly digest', later(2)),
      ]),
      'systemLarge'
    );
    expectBaselines(tree, 'systemLarge', [
      ['3', 128],
      ['Scheduled', 158],
      ['Next run', 182],
      ['Next scheduled', 232],
      ['Usage report', 258],
      ['Dependency audit', 292],
      ['Weekly digest', 326],
    ]);
    expect(fontSize(textNode(tree, '3'))).toBe(80);
  });
});

describe('nothing running, updating, last known', () => {
  it('keeps + on the small card and moves create into a pill on medium and large', () => {
    const props = propsFor([], { status: 'empty' });
    expectBaselines(render(props, 'systemSmall'), 'systemSmall', [
      ['Nothing running right now', 123],
      ['Checked', 151],
    ]);
    expectBaselines(render(props, 'systemMedium'), 'systemMedium', [
      ['Nothing running right now', 91],
      ['New agent', 124],
      ['Checked', 151],
    ]);
    expectBaselines(render(props, 'systemLarge'), 'systemLarge', [
      ['Nothing running right now', 177.5],
      ['New agent', 222.5],
    ]);
    for (const family of HOME_FAMILIES) {
      const presses = buttons(render(props, family));
      // One create control per card.
      expect(presses).toEqual([expect.objectContaining({ pendingAction: 'new-agent' })]);
      const header = children(render(props, family))[0];
      expect(children(children(header).at(-1))).toHaveLength(family === 'systemSmall' ? 1 : 0);
    }
  });

  it.each(HOME_FAMILIES)('draws placeholder bars and no actions while updating in %s', family => {
    const tree = render(propsFor([], { status: 'waiting' }), family);
    expect(buttons(tree)).toEqual([]);
    expect(texts(tree)).toEqual(['Kilo', 'Updating agents']);
    expect(collect(tree).filter(node => node.kind === 'RoundedRectangle').length).toBeGreaterThan(
      1
    );
    expectBaselines(tree, family, [['Updating agents', family === 'systemLarge' ? 363 : 151]]);
  });

  it.each(HOME_FAMILIES)(
    'keeps last known work with its time and no relative age in %s',
    family => {
      const tree = render(propsFor([PERMISSION], { now: NOW + 24 * 60 * MINUTE }), family);
      expect(texts(tree)).toContain('Last known ·');
      expect(texts(tree)).toContain('1');
      expect(collect(tree).some(node => node.props.dateStyle === 'ago')).toBe(false);
    }
  );
});

describe('locked', () => {
  it.each([
    ['privacy', 'Open Kilo to', 'see agents'],
    ['signed_out', 'Sign in to', 'see agents'],
  ] as const)('centres the lock and a balanced message for %s', (status, first, second) => {
    const props = propsFor([PERMISSION], { status });
    const small = render(props, 'systemSmall');
    expect(texts(small)).toEqual(['Kilo', first, second]);
    expectBaselines(small, 'systemSmall', [
      [first, 109.5],
      [second, 126.5],
    ]);
    const full = `${first} ${second}`;
    expectBaselines(render(props, 'systemMedium'), 'systemMedium', [[full, 119.5]]);
    expectBaselines(render(props, 'systemLarge'), 'systemLarge', [[full, 237.5]]);
    for (const family of HOME_FAMILIES) {
      const tree = render(props, family);
      expect(buttons(tree)).toEqual([]);
      expect(texts(tree)).not.toContain('Checked');
      expect(collect(tree).some(node => node.props.systemName === 'lock.fill')).toBe(true);
    }
  });
});

describe('stress', () => {
  it('groups a four-digit count, keeps it whole, and truncates long titles to one line', () => {
    const title = 'Untangle the payment reconciliation job that keeps timing out';
    const props = propsFor(Array.from({ length: 1234 }, () => ({ ...PERMISSION, title })));
    for (const family of HOME_FAMILIES) {
      const tree = render(props, family);
      const countNode = textNode(tree, '1,234');
      expect(countNode, family).toBeDefined();
      expect(modifier(countNode, 'fixedSize')).toEqual({
        horizontal: true,
        vertical: false,
      });
      expect(modifier(textNode(tree, title), 'lineLimit')).toBe(1);
      expect(
        collect(tree).some(node =>
          modifiers(node).some(entry => entry.$type === 'minimumScaleFactor')
        )
      ).toBe(false);
    }
  });

  it.each(HOME_FAMILIES)('names an untitled agent in %s', family => {
    const tree = render(propsFor([{ status: 'question', title: '' }]), family);
    expect(texts(tree)).toContain('Agent');
  });

  it('contains malformed persisted props without throwing in any family', () => {
    const corrupt = {
      countLines: [null, { kind: 'unknown', count: 'bad', label: {} }],
      primaryKind: 'unknown',
      primaryLabel: {},
      primaryCount: Number.NaN,
      actionFeedback: 7,
      home: {
        status: 'unknown',
        secondaryCounts: [null, { kind: 'unknown' }],
        waitingAgents: [null],
        scheduledAgents: {},
        checkedAt: 'bad',
        scheduledAt: 'bad',
      },
    } as unknown as GlanceableWidgetProps;
    for (const family of [...HOME_FAMILIES, ...ACCESSORY_FAMILIES]) {
      expect(() => render(corrupt, family)).not.toThrow();
    }
  });
});

describe('Lock Screen accessories', () => {
  it('stays privacy-minimal and monochrome with no buttons', () => {
    const props = propsFor([PERMISSION, BUSY, scheduled('Usage report', null)]);
    for (const family of ACCESSORY_FAMILIES) {
      const tree = render(props, family);
      expect(buttons(tree)).toEqual([]);
      expect(texts(tree)).not.toContain('Migrate the billing webhooks');
      const colors = collect(tree)
        .flatMap(node => modifiers(node))
        .filter(entry => entry.$type === 'foregroundStyle')
        .map(entry => entry.args as unknown as string);
      expect(colors.every(color => color === '#FFFFFF' || color === '#000000')).toBe(true);
    }
  });

  it('prints the primary count and the others in the rectangular', () => {
    const tree = render(
      propsFor([PERMISSION, BUSY, scheduled('Usage report', null)]),
      'accessoryRectangular'
    );
    expect(texts(tree)).toEqual(['Kilo', '1 Needs input', '1 Working · 1 Scheduled']);
    const others = textNode(tree, '1 Working · 1 Scheduled');
    expect(modifier(others, 'opacity')).toBe(0.62);
    // The monochrome glyph template, never the yellow tile.
    const marks = collect(tree).filter(node => node.props.uiImage !== undefined);
    expect(marks.map(node => node.props.uiImage)).toEqual(['__KILO_WIDGET_GLYPH_URI__']);
  });

  it('draws the symbol over the count in the circular and symbol + count in the inline', () => {
    const props = propsFor([PERMISSION]);
    const circular = render(props, 'accessoryCircular');
    expect(collect(circular).map(node => node.kind)).toContain('AccessoryWidgetBackground');
    expect(collect(circular).find(node => node.kind === 'Image')?.props.systemName).toBe(
      'exclamationmark.circle'
    );
    expect(texts(circular)).toEqual(['1']);
    expect(texts(render(props, 'accessoryInline'))).toEqual(['1 Needs input']);
  });

  it('draws a state glyph, never a placeholder dash, when nothing counts', () => {
    const expected = {
      waiting: 'arrow.triangle.2.circlepath',
      empty: 'checkmark.circle.fill',
      privacy: 'lock.fill',
      signed_out: 'person.fill',
    } as const;
    for (const status of Object.keys(expected) as (keyof typeof expected)[]) {
      const tree = render(propsFor([], { status }), 'accessoryCircular');
      expect(
        collect(tree)
          .filter(node => node.kind === 'Image')
          .map(node => node.props.systemName)
      ).toEqual([expected[status]]);
      expect(texts(tree)).not.toContain('—');
    }
  });
});
