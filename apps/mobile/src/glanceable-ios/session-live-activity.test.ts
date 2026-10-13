/* eslint-disable max-lines -- one cohesive layout suite for one stringified widget function */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LiveActivityEnvironment } from 'expo-widgets';

import { SESSION_CARD_QUIET_AFTER_MS } from '@kilocode/notifications';

import { sessionLiveActivityLayout } from './session-live-activity';

function mockComponent(kind: string) {
  return Object.assign((props: Record<string, unknown>) => ({ kind, props }), { kind });
}

function mockModifier(name: string) {
  return (args?: unknown) => ({ $type: name, args });
}

vi.mock('expo-widgets', () => ({ createLiveActivity: () => ({}), widgetsDirectory: '' }));
vi.mock('@expo/ui/swift-ui', () => ({
  Button: mockComponent('Button'),
  Circle: mockComponent('Circle'),
  HStack: mockComponent('HStack'),
  Image: mockComponent('Image'),
  Link: mockComponent('Link'),
  RoundedRectangle: mockComponent('RoundedRectangle'),
  Spacer: mockComponent('Spacer'),
  Text: mockComponent('Text'),
  VStack: mockComponent('VStack'),
  ZStack: mockComponent('ZStack'),
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: mockModifier('accessibilityElement'),
  accessibilityLabel: mockModifier('accessibilityLabel'),
  activityBackgroundTint: mockModifier('activityBackgroundTint'),
  background: (style: unknown) => ({ $type: 'background', args: style }),
  buttonStyle: mockModifier('buttonStyle'),
  cornerRadius: mockModifier('cornerRadius'),
  environment: mockModifier('environment'),
  fixedSize: mockModifier('fixedSize'),
  font: mockModifier('font'),
  foregroundStyle: mockModifier('foregroundStyle'),
  frame: mockModifier('frame'),
  layoutPriority: mockModifier('layoutPriority'),
  lineLimit: mockModifier('lineLimit'),
  monospacedDigit: mockModifier('monospacedDigit'),
  opacity: mockModifier('opacity'),
  padding: mockModifier('padding'),
  resizable: mockModifier('resizable'),
  shapes: { capsule: () => ({}) },
}));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));

type Rendered = { kind: string; props: Record<string, unknown> };
type State = Parameters<typeof sessionLiveActivityLayout>[0];

function element(node: unknown): Rendered | null {
  if (node === null || typeof node !== 'object' || !('type' in node) || !('props' in node)) {
    return null;
  }
  const { type, props } = node;
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- walks the untyped JSX element tree
  if (typeof type !== 'function' || !('kind' in type) || typeof type.kind !== 'string') {
    return null;
  }
  return { kind: type.kind, props: props as Record<string, unknown> };
}

function collect(node: unknown): Rendered[] {
  const root = element(node);
  if (root === null) {
    return Array.isArray(node) ? node.flatMap(item => collect(item)) : [];
  }
  const raw = root.props.children;
  const kids = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
  return [root, ...kids.flatMap(child => collect(child))];
}

/** Every element under a collected element. */
const descendants = (item: Rendered | undefined) =>
  item === undefined ? [] : collect(item.props.children);

const texts = (node: unknown) =>
  collect(node)
    .filter(item => item.kind === 'Text' && typeof item.props.children === 'string')
    .map(item => item.props.children as string);

const ENVIRONMENT: LiveActivityEnvironment = { colorScheme: 'light' };
const NOW = Date.parse('2026-10-12T10:00:00.000Z');

function render(state: State, environment: LiveActivityEnvironment = ENVIRONMENT) {
  return sessionLiveActivityLayout(state, environment);
}

/**
 * Render with baked copy. No widget transform runs under vitest, so the copy
 * placeholder stays a literal and the layout parses the empty fallback; this
 * hands the layout `copy` for that one parse instead.
 */
function renderWithCopy(copy: Record<string, string>) {
  return (state: State) => {
    const parse = JSON.parse.bind(JSON);
    const spy = vi
      .spyOn(JSON, 'parse')
      .mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) =>
        text === '{}' ? { ...copy } : parse(text, reviver)
      );
    try {
      return sessionLiveActivityLayout(state, ENVIRONMENT);
    } finally {
      spy.mockRestore();
    }
  };
}

const BASE: State = {
  sessionId: 'ses_1',
  title: 'Migrate the billing webhooks',
  statusKind: 'running',
  statusSince: new Date(NOW - 12 * 60_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  lastActivityAt: new Date(NOW - 20_000).toISOString(),
  startedAt: new Date(NOW - 38 * 60_000).toISOString(),
};

// Every state reads the clock (the quiet window, the wake time, today's
// date), so each test renders at the fixed moment the fixtures name.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session card layout: states', () => {
  it('shows the step, the plan progress, and the file changes while working', () => {
    const { banner } = render({
      ...BASE,
      currentStep: { verb: 'editing', target: 'auth.ts' },
      plan: { done: 3, total: 7, current: 'Write tests' },
      changes: { files: 4, added: 120, removed: 30 },
    });
    const shown = texts(banner);
    expect(shown).toContain('Editing auth.ts');
    expect(shown).toContain('3');
    expect(shown).toContain('of');
    expect(shown).toContain('7');
    expect(shown).toContain('Write tests');
    // The diff size is on the Lock Screen card too (spec "Content" rule 8).
    expect(shown).toContain('+120');
    expect(shown).toContain('−30');
  });

  it('says no activity once the quiet window has passed', () => {
    const { banner } = render({
      ...BASE,
      statusSince: new Date(NOW - 20 * 60_000).toISOString(),
      lastActivityAt: new Date(NOW - SESSION_CARD_QUIET_AFTER_MS - 60_000).toISOString(),
      currentStep: { verb: 'reading', target: 'auth.ts' },
    });
    const shown = texts(banner);
    // One line: the quiet warning, once, and no step beside or under it.
    expect(shown.filter(value => value === 'No activity for')).toHaveLength(1);
    expect(shown.some(value => value.includes('auth.ts'))).toBe(false);
    expect(shown).not.toContain('Reading auth.ts');
    // The quiet line replaces the last-known header instead of repeating it.
    expect(shown).not.toContain('Last known ·');
  });

  it('shows the step with its verb while the session works', () => {
    const shown = texts(
      render({ ...BASE, currentStep: { verb: 'reading', target: 'auth.ts' } }).banner
    );
    expect(shown).toContain('Reading auth.ts');
  });

  it('names the state time of a scheduled and a finished card once', () => {
    const times = (state: State) =>
      collect(render(state).banner).filter(item => item.props.dateStyle === 'time');
    expect(
      times({
        ...BASE,
        statusKind: 'scheduled',
        scheduledAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      })
    ).toHaveLength(1);
    expect(
      times({
        ...BASE,
        statusKind: 'idle',
        statusSince: new Date().toISOString(),
        outcome: { kind: 'none' },
      })
    ).toHaveLength(1);
  });

  it('draws one plan line per card', () => {
    const plan = { done: 3, total: 7, current: 'Write tests' };
    const counts = (state: State) => {
      const shown = texts(render(state).banner);
      return {
        full: shown.filter(value => value === '7').length,
        compact: shown.filter(value => value === '3/7').length,
        // The bar is a track plus its filled segment.
        bars: collect(render(state).banner).filter(
          item =>
            item.kind === 'ZStack' &&
            descendants(item).some(child => child.kind === 'RoundedRectangle')
        ).length,
      };
    };
    // Working: the bar and its count, once.
    expect(counts({ ...BASE, plan })).toEqual({ full: 1, compact: 0, bars: 1 });
    // Every other state: the compact count alone, once.
    for (const statusKind of ['scheduled', 'failed'] as const) {
      expect(
        counts({
          ...BASE,
          statusKind,
          plan,
          scheduledAt: new Date(Date.now() + 90 * 60_000).toISOString(),
          failure: { kind: 'other' },
        })
      ).toEqual({ full: 0, compact: 1, bars: 0 });
    }
    // A finished card keeps its plan progress, as the compact count once
    // (spec "Content" rule 6).
    expect(
      counts({
        ...BASE,
        statusKind: 'idle',
        statusSince: new Date(NOW).toISOString(),
        outcome: { kind: 'none' },
        plan,
      })
    ).toEqual({ full: 0, compact: 1, bars: 0 });
    expect(counts({ ...BASE, statusKind: 'needsInput', plan })).toEqual({
      full: 0,
      compact: 1,
      bars: 0,
    });
  });

  it('shows the last-known time when a card in another state is out of date', () => {
    const { banner } = render(
      { ...BASE, statusKind: 'scheduled', scheduledAt: new Date(NOW + 3_600_000).toISOString() },
      { colorScheme: 'light', isStale: true }
    );
    expect(texts(banner)).toContain('Last known ·');
  });

  it('shows the trimmed command with Approve and Open on a permission wait', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'needsInput',
      awaitingPermission: true,
      approvalKey: 'a'.repeat(64),
      permissionCommand: 'pnpm drizzle migrate',
      plan: { done: 3, total: 7, current: null },
    });
    const shown = texts(banner);
    expect(shown).toContain('Needs input');
    expect(shown).toContain('Wants to run');
    expect(shown).toContain('pnpm drizzle migrate');
    expect(shown).toContain('Approve');
    // Open is a round icon with a spoken label, so the card fits the controls.
    const open = collect(banner).find(item => item.kind === 'Link');
    expect(
      descendants(open).some(item => item.kind === 'Image' && item.props.systemName !== undefined)
    ).toBe(true);
    expect(shown).not.toContain('Open');
    // The plan bar stays off this state: the command owns the room.
    expect(shown).not.toContain('7');
  });

  it('answers a question with the step count and Open', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'needsInput',
      awaitingPermission: false,
      plan: { done: 2, total: 5, current: null },
    });
    const shown = texts(banner);
    expect(shown).toContain('Answer needed');
    // A question has nothing to approve: Open alone is the way to answer it.
    expect(shown).not.toContain('Approve');
    expect(collect(banner).some(item => item.kind === 'Link')).toBe(true);
  });

  it('shows the wake time and the steps done while scheduled', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'scheduled',
      scheduledAt: new Date(NOW + 90 * 60_000).toISOString(),
      plan: { done: 4, total: 9, current: null },
    });
    const shown = texts(banner);
    expect(shown).toContain('Scheduled');
    expect(shown).toContain('4/9');
    expect(shown).not.toContain('Awaiting update');
  });

  it('shows the duration and the outcome when finished', () => {
    const { banner, expandedBottom } = render({
      ...BASE,
      statusKind: 'idle',
      statusSince: new Date(NOW).toISOString(),
      outcome: { kind: 'pr_opened' },
      changes: { files: 6, added: 220, removed: 40 },
      costMicrodollars: 123_000,
    });
    const shown = texts(banner);
    expect(shown).toContain('Finished');
    expect(shown).toContain('Finished in 38 min');
    expect(shown).toContain('Pull request opened');
    // The cost belongs to the expanded view and to a finished card.
    expect(shown).toContain('$0.12');
    expect(texts(expandedBottom)).toContain('$0.12');
  });

  it('writes the cost with the app language digits, decimal separator and currency template', () => {
    const finished = (costMicrodollars: number, copy?: Record<string, string>) =>
      texts(
        (copy === undefined ? render : renderWithCopy(copy))({
          ...BASE,
          statusKind: 'idle',
          statusSince: new Date(NOW).toISOString(),
          outcome: { kind: 'none' },
          costMicrodollars,
        }).banner
      );
    // The app's own cost rules: two decimals from half a cent, four below it,
    // and nothing below the four-decimal zero.
    expect(finished(1_234_500)).toContain('$1.23');
    expect(finished(3100)).toContain('$0.0031');
    expect(finished(40).some(value => value.startsWith('$'))).toBe(false);
    // A German template and an Arabic digit table, as the copy bakes them.
    expect(finished(1_250_000, { costTemplate: '# $', costDecimal: ',' })).toContain('1,25 $');
    expect(
      finished(1_250_000, { costTemplate: '# US$', costDecimal: '٫', digits: '٠١٢٣٤٥٦٧٨٩' })
    ).toContain('١٫٢٥ US$');
  });

  it('keeps the cost off a working Lock Screen card and shows it when finished', () => {
    const working = texts(
      render({
        ...BASE,
        costMicrodollars: 120_000,
        changes: { files: 4, added: 120, removed: 30 },
      }).banner
    );
    expect(working).not.toContain('$0.12');
    const done = texts(
      render({
        ...BASE,
        statusKind: 'idle',
        statusSince: new Date(NOW).toISOString(),
        costMicrodollars: 120_000,
        outcome: { kind: 'none' },
      }).banner
    );
    expect(done).toContain('$0.12');
    const stopped = texts(
      render({
        ...BASE,
        statusKind: 'failed',
        failure: { kind: 'tool' },
        costMicrodollars: 120_000,
      }).banner
    );
    expect(stopped).toContain('$0.12');
  });

  it('shows the stop reason and the files changed when the turn failed', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'failed',
      statusSince: new Date().toISOString(),
      failure: { kind: 'provider' },
      changes: { files: 3, added: 12, removed: 4 },
      plan: { done: 2, total: 5, current: null },
    });
    const shown = texts(banner);
    expect(shown).toContain('Stopped: provider error');
    expect(shown).toContain('2/5');
    // The card names when it stopped, like every other state (spec "Content" rule 3).
    expect(collect(banner).some(item => item.props.dateStyle === 'time')).toBe(true);
  });

  it('never prints the step target twice, and keeps a target-only step readable', () => {
    const both = texts(
      render({
        ...BASE,
        currentStep: { verb: 'running', target: 'pnpm test' },
      }).banner
    );
    expect(both.filter(value => value.includes('pnpm'))).toHaveLength(1);
    const other = texts(render({ ...BASE, currentStep: { verb: 'other', target: 'task' } }).banner);
    expect(other).toContain('task');
  });
});

describe('session card layout: surfaces', () => {
  it('keeps the compact island on the state and its time, and the minimal one on the dot', () => {
    const { compactTrailing, minimal } = render(BASE);
    expect(collect(compactTrailing).map(item => item.kind)).toContain('Circle');
    expect(collect(minimal).map(item => item.kind)).toEqual(['HStack', 'Circle']);
  });

  it('carries the same status label spoken on every surface', () => {
    const label = (node: unknown) =>
      collect(node)
        .flatMap(item => {
          const raw = item.props.modifiers;
          return Array.isArray(raw) ? raw : [];
        })
        .map(modifier => modifier as { $type?: string; args?: unknown })
        .find(modifier => modifier.$type === 'accessibilityLabel')?.args;
    const state = render({
      ...BASE,
      statusKind: 'needsInput',
      awaitingPermission: true,
      approvalKey: 'a'.repeat(64),
      permissionCommand: 'pnpm test',
    });
    expect(String(label(state.banner))).toContain('Needs input');
    expect(String(label(state.banner))).toContain('Wants to run pnpm test');
  });

  it('renders the whole card in the expanded island with the diff and the cost', () => {
    const { expandedBottom } = render({
      ...BASE,
      changes: { files: 4, added: 120, removed: 30 },
      costMicrodollars: 120_000,
    });
    const shown = texts(expandedBottom);
    expect(shown).toContain('+120');
    expect(shown).toContain('−30');
    expect(shown).toContain('$0.12');
    // The diff line prints its own label; the outcome line owns none on a
    // working card, so the number of files prints once.
    expect(shown).toContain('4');
  });

  it('draws the plan bar from plain shapes that render on the Lock Screen', () => {
    const banner = render({ ...BASE, plan: { done: 3, total: 4, current: null } }).banner;
    const kinds = collect(banner).map(item => item.kind);
    // A ProgressView blanked the whole Lock Screen card on iOS.
    expect(kinds).not.toContain('ProgressView');
    const segments = collect(banner).filter(item => item.kind === 'RoundedRectangle');
    const widths = segments.map(segment => {
      const modifiers = segment.props.modifiers as { $type: string; args?: { width?: number } }[];
      return modifiers.find(modifier => modifier.$type === 'frame')?.args?.width;
    });
    // The track and the filled three quarters of it.
    expect(widths).toEqual([64, 48]);
    // An empty plan draws the track alone.
    const empty = render({ ...BASE, plan: { done: 0, total: 4, current: null } }).banner;
    expect(collect(empty).filter(item => item.kind === 'RoundedRectangle')).toHaveLength(1);
  });

  it('fits the permission controls inside the card at the four-side padding', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'needsInput',
      awaitingPermission: true,
      approvalKey: 'a'.repeat(64),
      permissionCommand: 'pnpm --filter web exec next build --no-lint',
    });
    // The card keeps its equal 16 pt inset.
    const root = element(banner);
    expect(root).not.toBeNull();
    const padding = (root?.props.modifiers as { $type: string; args?: unknown }[] | undefined)?.find(
      modifier => modifier.$type === 'padding'
    );
    expect(padding?.args).toEqual({ all: 16 });
    // No control reserves a minimum width: each pill takes its label's width.
    const frames = collect(banner).flatMap(item =>
      ((item.props.modifiers ?? []) as { $type: string; args?: { minWidth?: number } }[]).filter(
        modifier => modifier.$type === 'frame' && modifier.args?.minWidth !== undefined
      )
    );
    expect(frames).toEqual([]);
    // The command truncates at the end instead of holding its full width.
    const command = collect(banner).find(
      item =>
        item.kind === 'Text' &&
        item.props.children === 'pnpm --filter web exec next build --no-lint'
    );
    const commandModifiers = (command?.props.modifiers ?? []) as { $type: string }[];
    expect(commandModifiers.map(modifier => modifier.$type)).not.toContain('fixedSize');
    // The status label still never truncates.
    const label = collect(banner).find(item => item.props.children === 'Needs input');
    expect(((label?.props.modifiers ?? []) as { $type: string }[]).map(m => m.$type)).toContain(
      'fixedSize'
    );
  });

  it('keeps the approve and open targets for a press', () => {
    const { banner } = render({
      ...BASE,
      statusKind: 'needsInput',
      awaitingPermission: true,
      approvalKey: 'a'.repeat(64),
    });
    const buttons = collect(banner).filter(item => item.kind === 'Button');
    expect(buttons.map(button => button.props.target)).toEqual(['approve']);
    expect(collect(banner).some(item => item.kind === 'Link')).toBe(true);
  });
});
