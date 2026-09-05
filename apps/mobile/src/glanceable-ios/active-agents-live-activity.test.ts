import { describe, expect, it, vi } from 'vitest';

import { Text } from '@expo/ui/swift-ui';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { glanceableLayoutCopy } from './layout-copy';
// Constructing the exported handle registers the layout, which the mocked
// `createLiveActivity` below captures. vitest hoists the mocks above imports.
import './active-agents-live-activity';

// The `'widget'` layout is stringified by Babel and re-evaluated inside the
// widget process, where the copy and logo placeholders are already replaced.
// No widget transform runs under vitest, so the module holds the real function
// and the placeholders stay literals. This suite renders that exact function:
// the swift-ui tree and react-native are stubbed, `createLiveActivity` captures
// the layout it was registered with, and `JSON.parse` is stubbed to answer the
// copy placeholder the way the baked source literal does on device.
vi.mock('@expo/ui/swift-ui', () => ({
  Text: () => null,
  VStack: () => null,
  HStack: () => null,
  Spacer: () => null,
  Image: () => null,
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: (...args: unknown[]) => ({ mod: 'accessibilityElement', args }),
  accessibilityLabel: (...args: unknown[]) => ({ mod: 'accessibilityLabel', args }),
  allowsTightening: (...args: unknown[]) => ({ mod: 'allowsTightening', args }),
  cornerRadius: (...args: unknown[]) => ({ mod: 'cornerRadius', args }),
  environment: (...args: unknown[]) => ({ mod: 'environment', args }),
  font: (...args: unknown[]) => ({ mod: 'font', args }),
  foregroundStyle: (...args: unknown[]) => ({ mod: 'foregroundStyle', args }),
  frame: (...args: unknown[]) => ({ mod: 'frame', args }),
  layoutPriority: (...args: unknown[]) => ({ mod: 'layoutPriority', args }),
  lineLimit: (...args: unknown[]) => ({ mod: 'lineLimit', args }),
  minimumScaleFactor: (...args: unknown[]) => ({ mod: 'minimumScaleFactor', args }),
  monospacedDigit: (...args: unknown[]) => ({ mod: 'monospacedDigit', args }),
  padding: (...args: unknown[]) => ({ mod: 'padding', args }),
  resizable: (...args: unknown[]) => ({ mod: 'resizable', args }),
}));
vi.mock('react-native', () => ({
  PlatformColor: (name: string) => name,
  Image: { resolveAssetSource: () => ({ uri: '' }) },
}));

const captured = vi.hoisted(() => ({ layout: null as unknown }));
vi.mock('expo-widgets', () => ({
  after: (date: Date) => ({ after: date }),
  widgetsDirectory: 'file:///app-group/ExpoWidgets/',
  createLiveActivity: (_name: string, layout: unknown) => {
    captured.layout = layout;
    return { start: () => null, getInstances: () => [] };
  },
}));

type Rendered = Record<string, unknown>;

/**
 * Render the registered layout for one pushed content state, baking the copy
 * the same way `withGlanceableCopy` patches the stringified source on device.
 */
function render(content: Partial<GlanceableLiveActivityContentState>): Rendered {
  const copy = JSON.stringify(glanceableLayoutCopy());
  const realParse = JSON.parse;
  vi.stubGlobal('JSON', {
    parse: (text: string) =>
      text === '__KILO_GLANCEABLE_COPY__' ? realParse(copy) : realParse(text),
  });
  try {
    const layout = captured.layout as (
      props: Partial<GlanceableLiveActivityContentState>
    ) => Rendered;
    return layout(content);
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Every string a `Text` node draws anywhere in the surface tree. */
function drawnText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      drawnText(item, out);
    }
    return out;
  }
  if (node === null || typeof node !== 'object') {
    return out;
  }
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.type === Text && typeof element.props?.children === 'string') {
    out.push(element.props.children);
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    drawnText(value, out);
  }
  return out;
}

/** The spoken label the surface attaches to its accessibility element. */
function spokenLabel(node: unknown): string {
  let label = '';
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    const marker = value as { mod?: string; args?: unknown[] };
    if (marker.mod === 'accessibilityLabel' && typeof marker.args?.[0] === 'string') {
      label = marker.args[0];
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child);
    }
  };
  visit(node);
  return label;
}

describe('ActiveAgentsLiveActivity layout', () => {
  it('clears the island number when an idle-only snapshot resolves to empty', () => {
    // e23: the question was answered elsewhere and the session landed in
    // `idle`. The terminal content state keeps the idle count, but the island
    // must not show "1" beside a cleared badge — every surface draws the
    // empty status line instead, exactly like the widget props do.
    const rendered = render({
      status: 'empty',
      running: 0,
      needsInput: 0,
      idle: 1,
      needsInputSince: null,
    });

    expect(drawnText(rendered.compactTrailing).join('')).toBe('');
    expect(drawnText(rendered.minimal).join('')).toBe('');
    expect(drawnText(rendered.banner)).toEqual(['No work in progress']);
    expect(drawnText(rendered.expandedBottom)).toEqual(['No work in progress']);
    expect(spokenLabel(rendered.banner)).toBe('No work in progress, Open agents');
  });

  it('shows the ranked number on the island while work is eligible', () => {
    // The idle row keeps drawing beside real work, and the compact island
    // shows the top-ranked non-zero count — needs-input outranks idle.
    const rendered = render({
      status: 'happy',
      running: 0,
      needsInput: 1,
      idle: 1,
      needsInputSince: null,
    });

    expect(drawnText(rendered.compactTrailing)).toEqual(['1']);
    const banner = drawnText(rendered.banner);
    expect(banner).toContain('Needs input');
    expect(banner).toContain('Idle');
    expect(spokenLabel(rendered.banner)).toBe('1 Needs input, 1 Idle, Open agents');
  });

  it('keeps the zero rows on the banner so the grid never reflows', () => {
    const rendered = render({
      status: 'happy',
      running: 2,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    });

    expect(drawnText(rendered.compactTrailing)).toEqual(['2']);
    expect(drawnText(rendered.banner)).toEqual(['0', 'Needs input', '2', 'Working', '0', 'Idle']);
    expect(spokenLabel(rendered.banner)).toBe('2 Working, Open agents');
  });

  it('draws the stale status word beside the frozen counts', () => {
    const rendered = render({
      status: 'stale',
      running: 1,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    });

    expect(drawnText(rendered.compactTrailing)).toEqual(['1']);
    expect(spokenLabel(rendered.banner)).toBe("Can't update now, 1 Working, Open agents");
  });

  it('draws the waiting line with no number', () => {
    const rendered = render({
      status: 'waiting',
      running: 0,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    });

    expect(drawnText(rendered.compactTrailing).join('')).toBe('');
    expect(drawnText(rendered.banner)).toEqual(['Updating agents']);
  });
});
