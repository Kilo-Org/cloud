/* eslint-disable max-lines -- one suite covering every composition and the state matrix through a shared mock-element tree harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { renderActiveAgentsWidget } from './active-agents-widget';
import {
  type AndroidWidgetProps,
  buildAndroidWidgetProps,
  buildCurrentWidgetProps,
} from './widget-props';

// Stub the widget primitives so the layout functions return inspectable trees
// without loading react-native. The real components are exercised by prebuild.
vi.mock('react-native-android-widget', () => ({
  FlexWidget: (props: Record<string, unknown>) => ({ kind: 'FlexWidget', props }),
  TextWidget: (props: Record<string, unknown>) => ({ kind: 'TextWidget', props }),
  ImageWidget: (props: Record<string, unknown>) => ({ kind: 'ImageWidget', props }),
  requestWidgetUpdate: () => undefined,
}));

const NOW = 1_750_000_000_000;

/** The newest result's timestamp, forwarded to the age formatter below. */
const NEWEST_AT = new Date(NOW - 180_000).toISOString();
/** Two hours ahead of the suite's clock: the soonest scheduled wake. */
const WAKE = new Date(NOW + 7_200_000).toISOString();

type MockElement = {
  type?: { name?: string } | string;
  props: {
    text?: string;
    clickAction?: string;
    clickActionData?: { uri?: string };
    accessibilityLabel?: string;
    allowFontScaling?: boolean;
    maxLines?: number;
    style?: {
      backgroundColor?: string;
      borderColor?: string;
      justifyContent?: string;
      alignItems?: string;
      height?: number | string;
    };
    children?: unknown;
  };
};

const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.idle': 'Idle',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
  'glanceable.waiting': 'Waiting for agents',
  'glanceable.empty': 'No work in progress',
  'glanceable.expired': 'Status expired',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.stale': 'Updates delayed',
  'glanceable.openAgents': 'Open agents',
  'glanceable.newestResult': 'Newest result',
  'glanceable.noneWaiting': 'No agents waiting',
  'glanceable.newAgent': 'New agent',
  'glanceable.approving': 'Approving…',
  'glanceable.couldNotApprove': 'Could not approve',
  'glanceable.newestSession': 'Newest: {{title}}',
  'common.approve': 'Approve',
};

afterEach(() => {
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  vi.useRealTimers();
});

function translate(key: string): string {
  return COPY[key] ?? key;
}

/** The formatters the app injects, stubbed to short, realistic strings. */
const formatAgo = (): string => '3 min ago';
const formatClock = (): string => '8:00 PM';

/**
 * The cell sizes (w x h dp) the Pixel 6 launcher reports for every span from
 * 2x1 to 4x4, portrait and landscape: the sizes the widget is drawn at.
 */
const LAUNCHER_CELLS = [
  { span: '2x1', width: 172, height: 104 },
  { span: '3x1', width: 266, height: 104 },
  { span: '4x1', width: 360, height: 104 },
  { span: '2x2', width: 172, height: 224 },
  { span: '3x2', width: 266, height: 224 },
  { span: '4x2', width: 360, height: 224 },
  { span: '2x3', width: 172, height: 344 },
  { span: '3x3', width: 266, height: 344 },
  { span: '4x3', width: 360, height: 344 },
  { span: '4x4', width: 360, height: 464 },
  { span: '2x1 landscape', width: 307, height: 62 },
  { span: '3x1 landscape', width: 467, height: 62 },
  { span: '4x1 landscape', width: 627, height: 62 },
  { span: '2x2 landscape', width: 307, height: 135 },
  { span: '3x2 landscape', width: 467, height: 135 },
  { span: '4x2 landscape', width: 627, height: 135 },
  { span: '2x3 landscape', width: 307, height: 208 },
  { span: '3x3 landscape', width: 467, height: 208 },
  { span: '4x3 landscape', width: 627, height: 208 },
  { span: '4x4 landscape', width: 627, height: 281 },
];

function snapshotFor(
  sessions: { status: string; statusUpdatedAt?: string; scheduledAt?: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

function propsFor(snapshot: GlanceableAgentsSnapshot): AndroidWidgetProps {
  return buildAndroidWidgetProps(snapshot, {}, translate, String, formatAgo, formatClock);
}

/** Every state at once: two approvable waits, work, a scheduled wake, idle, and a newest result. */
function mixedProps(): AndroidWidgetProps {
  return propsFor(
    snapshotFor([
      { status: 'permission' },
      { status: 'permission' },
      { status: 'busy', statusUpdatedAt: NEWEST_AT },
      { status: 'scheduled', scheduledAt: WAKE },
      { status: 'idle' },
    ])
  );
}

function children(element: MockElement): unknown[] {
  const kids = element.props.children;
  if (kids == null) {
    return [];
  }
  return Array.isArray(kids) ? kids.flat(Infinity) : [kids];
}

function walk(node: unknown, visit: (element: MockElement) => void): void {
  if (node == null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
    return;
  }
  const element = node as MockElement;
  visit(element);
  for (const child of children(element)) {
    walk(child, visit);
  }
}

function collectText(node: unknown): string[] {
  const text: string[] = [];
  walk(node, element => {
    if (typeof element.props.text === 'string') {
      text.push(element.props.text);
    }
  });
  return text;
}

function findAll(node: unknown, match: (element: MockElement) => boolean): MockElement[] {
  const found: MockElement[] = [];
  walk(node, element => {
    if (match(element)) {
      found.push(element);
    }
  });
  return found;
}

const NEW_AGENT_URI = 'kiloapp:///cloud/sessions/new';
const isApprove = (element: MockElement): boolean => element.props.clickAction === 'approve';
const isNewAgent = (element: MockElement): boolean =>
  element.props.clickActionData?.uri === NEW_AGENT_URI;
const isMark = (element: MockElement): boolean =>
  typeof element.props === 'object' && 'imageWidth' in element.props;

type Cell = { width: number; height: number; rtl?: boolean };

function render(props: AndroidWidgetProps, cell: Cell) {
  const { width, height, rtl = false } = cell;
  return renderActiveAgentsWidget(
    props,
    {
      widgetName: 'ActiveAgentsWidget',
      widgetId: 1,
      width,
      height,
      screenInfo: { screenWidthDp: 400, screenHeightDp: 800, density: 2, densityDpi: 320 },
    },
    rtl
  ) as unknown as { light: MockElement; dark: MockElement };
}

/** The visible numbers, in order. */
function counts(node: unknown): string[] {
  return collectText(node).filter(text => /^\d+$/.test(text));
}

describe('renderActiveAgentsWidget', () => {
  it('returns distinct light and dark layouts in the app palette', () => {
    const rep = render(mixedProps(), { width: 360, height: 344 });

    expect(rep.light).not.toBe(rep.dark);
    expect(rep.light.props.style?.backgroundColor).toBe(lightColors.background);
    expect(rep.dark.props.style?.backgroundColor).toBe(darkColors.background);
    // One plan draws both themes, so they never differ in what they show.
    expect(collectText(rep.dark)).toEqual(collectText(rep.light));
  });

  it('opens Kilo from the whole widget, in every composition', () => {
    for (const cell of LAUNCHER_CELLS) {
      for (const props of [mixedProps(), propsFor(snapshotFor([], 0, 'empty'))]) {
        const { light } = render(props, cell);
        expect(light.props.clickAction, cell.span).toBe('OPEN_URI');
        expect(light.props.clickActionData, cell.span).toEqual({
          uri: 'kiloapp:///cloud/sessions',
        });
        expect(light.props.accessibilityLabel, cell.span).toBe(props.accessibilityLabel);
      }
    }
  });

  // Rule: the action is always reachable. Every launcher cell can hold one line
  // of content plus the 48 dp action, so every one of them offers it.
  it('offers Approve at every launcher size, and never a count less', () => {
    const props = mixedProps();
    for (const cell of LAUNCHER_CELLS) {
      const { light } = render(props, cell);
      const approve = findAll(light, isApprove);
      expect(approve, cell.span).toHaveLength(1);
      expect(approve[0]?.props.accessibilityLabel).toBe('Approve');
      expect(approve[0]?.props.style?.height, cell.span).toBe(48);
      expect(counts(light), cell.span).toEqual(['2', '1', '1', '1']);
    }
  });

  it('offers New agent at every launcher size for the empty state', () => {
    const props = propsFor(snapshotFor([], 0, 'empty'));
    for (const cell of LAUNCHER_CELLS) {
      const { light } = render(props, cell);
      const chip = findAll(light, isNewAgent);
      expect(chip, cell.span).toHaveLength(1);
      // Starting an agent needs the composer: a plain deep link, no headless task.
      expect(chip[0]?.props.clickAction).toBe('OPEN_URI');
      expect(collectText(light), cell.span).toEqual(['No agents waiting', 'New agent']);
    }
  });

  it('offers New agent when every agent is idle', () => {
    const props = propsFor(snapshotFor([{ status: 'idle' }, { status: 'idle' }]));
    for (const cell of LAUNCHER_CELLS) {
      expect(findAll(render(props, cell).light, isNewAgent), cell.span).toHaveLength(1);
    }
  });

  // A retry or a question needs the app: no Approve whose press would only open it.
  it('draws no Approve for a wait the action cannot answer', () => {
    const props = propsFor(snapshotFor([{ status: 'retry' }]));
    for (const cell of LAUNCHER_CELLS) {
      expect(findAll(render(props, cell).light, isApprove), cell.span).toEqual([]);
    }
  });

  it('offers no action for a state with nothing to act on', () => {
    for (const status of ['waiting', 'signed_out', 'privacy', 'expired'] as const) {
      const { light } = render(propsFor(snapshotFor([], 0, status)), { width: 360, height: 344 });
      expect(
        findAll(light, element => element !== light && element.props.clickAction !== undefined),
        status
      ).toEqual([]);
    }
  });

  it('drops the action rather than clipping it in a cell too short for its target', () => {
    const { light } = render(propsFor(snapshotFor([], 0, 'empty')), { width: 172, height: 40 });

    expect(findAll(light, isNewAgent)).toEqual([]);
    expect(collectText(light)).toEqual(['No agents waiting']);
  });

  // Rule: overflow order in narrow cells — the wake first, then the secondary
  // labels, then the primary label, then the mark. Never a count, and never the
  // action while the cell can hold it beside the bare counts.
  it('drops the wake, then the labels, then the mark as a one-row cell narrows', () => {
    const props = mixedProps();
    const widths = [627, 520, 467, 400, 360, 307, 266];
    const seen = widths.map(width => {
      const { light } = render(props, { width, height: 62 });
      const text = collectText(light);
      return {
        width,
        time: text.includes('8:00 PM'),
        secondary: text.includes('Working'),
        primary: text.includes('Needs input'),
        mark: findAll(light, isMark).length > 0,
        approve: findAll(light, isApprove).length,
        counts: counts(light),
      };
    });

    for (const step of seen) {
      expect(step.counts, `${step.width}`).toEqual(['2', '1', '1', '1']);
      expect(step.approve, `${step.width}`).toBe(1);
    }
    // Once a piece is gone it stays gone at every narrower width.
    for (const key of ['time', 'secondary', 'primary', 'mark'] as const) {
      const firstGone = seen.findIndex(step => !step[key]);
      if (firstGone !== -1) {
        expect(
          seen.slice(firstGone).every(step => !step[key]),
          key
        ).toBe(true);
      }
    }
    // And a piece never outlives one ranked below it.
    for (const step of seen) {
      if (step.time) {
        expect(step.secondary, `${step.width}`).toBe(true);
      }
      if (step.secondary) {
        expect(step.primary, `${step.width}`).toBe(true);
      }
      if (step.primary) {
        expect(step.mark, `${step.width}`).toBe(true);
      }
    }
    expect(seen[0]).toMatchObject({ time: true, secondary: true, primary: true, mark: true });
  });

  it('mirrors every row for a right-to-left language', () => {
    const props = propsFor(snapshotFor([{ status: 'permission' }, { status: 'busy' }]));
    const ltr = collectText(render(props, { width: 627, height: 62 }).light);
    const rtl = collectText(render(props, { width: 627, height: 62, rtl: true }).light);

    // Each count row reads label-then-number, and the rows run right to left.
    expect(rtl.filter(text => text !== 'Approve')).toEqual(
      ltr.filter(text => text !== 'Approve').toReversed()
    );
  });

  // Arabic falls back to a font with taller lines than Roboto: four stacked
  // rows that fit a one-row cell in English cut the last one in Arabic.
  it('budgets taller lines for Arabic copy, so a one-row cell never stacks four rows', () => {
    const arabic: Record<string, string> = {
      'glanceable.needsInput': 'بانتظار تدخلك',
      'common.working': 'جارٍ العمل',
      'common.scheduled': 'مجدول',
      'common.idle': 'خامل',
    };
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }]),
      {},
      key => arabic[key] ?? translate(key),
      String,
      formatAgo,
      formatClock
    );
    const stacks = (cell: Cell, input: AndroidWidgetProps) =>
      findAll(
        render(input, cell).light,
        element =>
          (element.props.style as { flexDirection?: string } | undefined)?.flexDirection ===
            'column' && children(element).filter(child => counts(child).length === 1).length === 4
      ).length;

    expect(stacks({ width: 266, height: 104 }, mixedProps())).toBe(1);
    expect(stacks({ width: 266, height: 104, rtl: true }, props)).toBe(0);
    expect(counts(render(props, { width: 266, height: 104, rtl: true }).light)).toHaveLength(4);
  });

  it('hides counts and shows the expired copy for an expired snapshot', () => {
    const props = propsFor({
      ...snapshotFor([{ status: 'busy' }], 0),
      status: 'expired',
      running: 0,
      needsInput: 0,
      idle: 0,
    });

    expect(collectText(render(props, { width: 266, height: 104 }).light)).toEqual([
      'Status expired',
    ]);
  });

  // A widget cell is a fixed frame with no scrolling and no reflow, so text that
  // scaled with the system font size pushed the action out of it at Large text.
  it('pins every label to its dp size in every composition and theme', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    for (const cell of LAUNCHER_CELLS) {
      for (const [theme, surface] of Object.entries(render(mixedProps(), cell))) {
        const labels = findAll(surface, element => typeof element.props.text === 'string');
        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) {
          expect(
            label.props.allowFontScaling,
            `${theme} \`${label.props.text}\` at ${cell.span}`
          ).toBe(false);
        }
      }
    }
  });
});

describe('the tall counts card', () => {
  // Rule: a header row holds the mark at the leading edge and the action at the
  // trailing edge, and the count rows sit below it.
  it('heads the card with the mark and the action', () => {
    const { light } = render(mixedProps(), { width: 360, height: 344 });
    const header = findAll(
      light,
      element => findAll(element, isMark).length === 1 && findAll(element, isApprove).length === 1
    ).at(-1);

    expect(header).toBeDefined();
    expect(counts(header)).toEqual([]);
  });

  // Rule: the footer is pinned only when its caption and its line both fit;
  // the caption never draws alone.
  it('draws the newest-result footer only whole', () => {
    const props = mixedProps();
    for (const cell of LAUNCHER_CELLS) {
      const text = collectText(render(props, cell).light);
      if (text.includes('Newest result')) {
        expect(text, cell.span).toContain('Working');
        expect(text.indexOf('Newest result'), cell.span).toBeLessThan(text.lastIndexOf('Working'));
      }
    }
    expect(collectText(render(props, { width: 360, height: 344 }).light)).toContain(
      'Newest result'
    );
    expect(collectText(render(props, { width: 360, height: 224 }).light)).not.toContain(
      'Newest result'
    );
  });

  it('drops the footer age whole when the row would not fit with it', () => {
    const props = mixedProps();

    expect(collectText(render(props, { width: 360, height: 344 }).light)).toContain('3 min ago');
    const narrow = collectText(
      render(
        { ...props, newestResultAgo: '12 minutes ago' },
        {
          width: 140,
          height: 344,
        }
      ).light
    );
    expect(narrow).toContain('Newest result');
    expect(narrow).not.toContain('12 minutes ago');
  });

  // Rule: tall cards scale the count rows up with the height.
  it('sets the count rows larger in a taller card', () => {
    const fontOf = (cell: Cell) =>
      findAll(render(mixedProps(), cell).light, element => element.props.text === 'Needs input')[0]
        ?.props.style as { fontSize?: number } | undefined;

    const short = fontOf({ width: 360, height: 224 })?.fontSize ?? 0;
    const tall = fontOf({ width: 360, height: 464 })?.fontSize ?? 0;
    expect(tall).toBeGreaterThan(short);
    // Numbers and labels in one row share one size.
    const number = findAll(
      render(mixedProps(), { width: 360, height: 464 }).light,
      element => element.props.text === '2'
    )[0]?.props.style as { fontSize?: number } | undefined;
    expect(number?.fontSize).toBe(tall);
  });

  it('keeps the rows and states the delayed copy under the caption when stale', () => {
    const props = propsFor({
      ...snapshotFor([{ status: 'busy', statusUpdatedAt: NEWEST_AT }], 0, 'stale'),
      needsInput: 2,
      idle: 3,
      running: 4,
    });
    const text = collectText(render(props, { width: 360, height: 344 }).light);

    expect(counts(render(props, { width: 360, height: 344 }).light)).toEqual(['2', '4', '0', '3']);
    expect(text.slice(-2)).toEqual(['Newest result', 'Updates delayed']);
  });

  it('draws the delayed copy once the data lapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 31 * 60_000);
    const props = buildCurrentWidgetProps(
      {
        ...snapshotFor([{ status: 'busy', statusUpdatedAt: NEWEST_AT }], 0),
        needsInput: 2,
        idle: 3,
        running: 4,
      },
      translate,
      String,
      formatAgo,
      formatClock
    );
    vi.useRealTimers();
    const { light } = render(props, { width: 360, height: 344 });

    expect(collectText(light).slice(-2)).toEqual(['Newest result', 'Updates delayed']);
    expect(light.props.accessibilityLabel).toBe(
      'Updates delayed, 2 Needs input, 4 Working, 3 Idle, Open agents'
    );
  });

  it('draws the scheduled wake as a clock time, dropped whole when the row is too wide', () => {
    const props = mixedProps();
    // The deepest element that holds both the scheduled label and its count is its row.
    const scheduledRow = (cell: Cell) =>
      findAll(render(props, cell).light, element => {
        const text = collectText(element);
        return text.includes('Scheduled') && text.includes('1');
      }).at(-1);

    expect(collectText(scheduledRow({ width: 360, height: 344 }))).toEqual([
      '1',
      'Scheduled',
      '8:00 PM',
    ]);
    expect(collectText(scheduledRow({ width: 172, height: 224 }))).toEqual(['1', 'Scheduled']);
  });

  it('gives the scheduled marker its own color instead of the idle outline', () => {
    const rep = render(mixedProps(), { width: 360, height: 344 });
    const styles = (node: unknown) =>
      findAll(node, element => element.props.style !== undefined).map(
        element => element.props.style ?? {}
      );

    expect(styles(rep.light).some(style => style.backgroundColor === lightColors.mutedSoft)).toBe(
      true
    );
    expect(styles(rep.dark).some(style => style.backgroundColor === darkColors.mutedSoft)).toBe(
      true
    );
    expect(styles(rep.light).some(style => style.borderColor === lightColors.foreground)).toBe(
      true
    );
  });

  const fontOf = (node: unknown, text: string): number | undefined =>
    (
      findAll(node, element => element.props.text === text)[0]?.props.style as
        | { fontSize?: number }
        | undefined
    )?.fontSize;

  // The footer follows the rows: large rows over a footnote read as a mistake.
  it('scales the footer with the count rows, never below its base sizes', () => {
    const tall = render(mixedProps(), { width: 360, height: 464 }).light;
    const rowFont = fontOf(tall, 'Needs input') ?? 0;
    const lineFont = fontOf(tall, '3 min ago') ?? 0;
    const captionFont = fontOf(tall, 'Newest result') ?? 0;

    expect(rowFont).toBeGreaterThan(20);
    expect(lineFont).toBe(Math.round(rowFont * 0.7));
    expect(captionFont).toBe(Math.round(rowFont * 0.6));

    const short = render(mixedProps(), { width: 360, height: 344 }).light;
    expect(fontOf(short, '3 min ago')).toBeGreaterThanOrEqual(13);
    expect(fontOf(short, 'Newest result')).toBeGreaterThanOrEqual(11);
  });

  // Zero rows keep the grid still but must not compete with the real counts.
  it('draws a zero row muted: glyph, number, and label, the number not bold', () => {
    const props = propsFor(snapshotFor([{ status: 'permission' }]));
    const { light } = render(props, { width: 360, height: 344 });
    const working = findAll(light, element => {
      const text = collectText(element);
      return text.includes('Working') && text.includes('0');
    }).at(-1);
    const count = findAll(working, element => element.props.text === '0')[0]?.props.style as
      | { color?: string; fontWeight?: string }
      | undefined;
    const needs = findAll(light, element => element.props.text === '1')[0]?.props.style as
      | { color?: string; fontWeight?: string }
      | undefined;

    expect(count).toMatchObject({ color: lightColors.mutedForeground, fontWeight: 'normal' });
    expect(needs).toMatchObject({ color: lightColors.foreground, fontWeight: 'bold' });
    expect(
      findAll(working, element => element.props.style?.backgroundColor === lightColors.good)
    ).toEqual([]);
  });

  // A chip too wide to sit beside the mark takes its own row at the bottom;
  // the mark keeps the header.
  it('moves a wide action under the counts and keeps the mark', () => {
    const props = {
      ...mixedProps(),
      actions: { ...mixedProps().actions, approveLabel: 'Genehmigen' },
    };
    const { light } = render(props, { width: 172, height: 344 });
    const top = children(light).filter(child => child !== null && child !== undefined);

    expect(findAll(top[0], isMark)).toHaveLength(1);
    expect(findAll(top[0], isApprove)).toEqual([]);
    expect(findAll(top.at(-1), isApprove)).toHaveLength(1);
  });

  // One size for every row: a label too long for the cell shrinks the whole
  // column, down to the minimum, before any label ends in an ellipsis.
  it('shrinks the whole column to fit a long label, down to 12 dp', () => {
    const translateDe = (key: string) =>
      ({ 'glanceable.needsInput': 'Eingabe erforderlich' })[key] ?? translate(key);
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }]),
      {},
      translateDe,
      String,
      formatAgo,
      formatClock
    );
    const { light } = render(props, { width: 172, height: 344 });
    const sizes = ['Eingabe erforderlich', 'Working', 'Scheduled', 'Idle'].map(text =>
      fontOf(light, text)
    );

    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThan(15);
    expect(sizes[0]).toBeGreaterThanOrEqual(12);
  });
});

describe('the in-flight and failed Approve', () => {
  it('draws the progress line where the chip was while an Approve runs', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: 'approving' });
    const props = mixedProps();
    for (const cell of LAUNCHER_CELLS) {
      const { light } = render(props, cell);
      expect(findAll(light, isApprove), cell.span).toEqual([]);
      expect(collectText(light), cell.span).toContain('Approving…');
    }
  });

  it('keeps the chip to retry, with the failure over it, at every launcher size', () => {
    setSurfaceExtras({
      newestSessionTitle: 'Fix the flaky test',
      actionFeedback: 'couldNotApprove',
    });
    const props = mixedProps();
    for (const cell of LAUNCHER_CELLS) {
      const { light } = render(props, cell);
      expect(findAll(light, isApprove), cell.span).toHaveLength(1);
      expect(counts(light), cell.span).toEqual(['2', '1', '1', '1']);
    }
    const tall = collectText(render(props, { width: 360, height: 344 }).light);
    expect(tall).toContain('Could not approve');
    // The failure belongs to the chip, so the footer keeps the newest result.
    expect(tall).toContain('Newest result');
  });

  it('names the newest session over the newest result, and only once', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const text = collectText(render(mixedProps(), { width: 360, height: 344 }).light);

    expect(text.slice(-3)).toEqual(['Newest: Fix the flaky test', 'Working', '3 min ago']);
    expect(text).not.toContain('Newest result');
  });
});

describe('a state with no counts', () => {
  // Rule: count-less states in tall cards are one centered composition.
  it.each([
    ['waiting', 'Waiting for agents'],
    ['empty', 'No agents waiting'],
    ['expired', 'Status expired'],
    ['signed_out', 'Sign in to see agents'],
    ['privacy', 'Open Kilo to see agents'],
  ] as const)('centers the mark and the %s copy in a tall cell', (status, copy) => {
    const { light, dark } = render(propsFor(snapshotFor([], 0, status)), {
      width: 360,
      height: 344,
    });

    expect(light.props.style?.justifyContent).toBe('center');
    expect(light.props.style?.alignItems).toBe('center');
    expect(findAll(light, isMark)).toHaveLength(1);
    expect(collectText(light)[0]).toBe(copy);
    expect(collectText(dark)[0]).toBe(copy);
    expect(collectText(light)).not.toContain('Newest result');
  });
});
