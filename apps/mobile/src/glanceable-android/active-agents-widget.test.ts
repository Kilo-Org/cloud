/* eslint-disable max-lines -- one suite covering every size bucket and the state matrix through a shared mock-element tree harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { buildAndroidWidgetProps, buildCurrentWidgetProps } from './widget-props';

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

type MockElement = {
  kind: string;
  props: {
    text?: string;
    clickAction?: string;
    clickActionData?: { uri?: string };
    accessibilityLabel?: string;
    style?: { backgroundColor?: string; justifyContent?: string; height?: number };
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
});

function translate(key: string): string {
  return COPY[key] ?? key;
}

/** The two formatters the app injects, stubbed deterministically. `formatAgo`
 * echoes its argument, so the rendered age proves the forwarded timestamp. */
const formatAgo = (at: string): string => `ago:${at}`;
const AGO = formatAgo(NEWEST_AT);

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

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node !== 'object') {
    return [];
  }
  const element = node as MockElement;
  const output: string[] = [];
  if (typeof element.props.text === 'string') {
    output.push(element.props.text);
  }
  if (element.props.children !== undefined) {
    output.push(...collectText(element.props.children));
  }
  return output;
}

function findElement(
  node: unknown,
  match: (element: MockElement) => boolean
): MockElement | undefined {
  if (node == null) {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, match);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== 'object') {
    return undefined;
  }
  const element = node as MockElement;
  if (match(element)) {
    return element;
  }
  return findElement(element.props.children, match);
}

function collectStyles(node: unknown): Record<string, unknown>[] {
  const styles: Record<string, unknown>[] = [];
  const visit = (current: unknown): void => {
    if (current == null) {
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }
    if (typeof current !== 'object') {
      return;
    }
    const element = current as MockElement;
    if (element.props.style !== undefined) {
      styles.push(element.props.style as Record<string, unknown>);
    }
    visit(element.props.children);
  };
  visit(node);
  return styles;
}

type Cell = { width: number; height?: number; rtl?: boolean };

/** The count row whose own label is `label`, found through its direct children. */
function countRowFor(node: unknown, label: string): MockElement | undefined {
  return findElement(node, element => {
    const children = element.props.children;
    return (
      Array.isArray(children) &&
      children.some(child => (child as MockElement | null)?.props.text === label)
    );
  });
}

/**
 * The scheduled row's wake slot: the child that reserves a numeric height and
 * lays its own content out in a row. The state dot has a height too, so the
 * direction is what tells the two apart.
 */
function wakeSlotStyle(row: MockElement | undefined): Record<string, unknown> | undefined {
  return row === undefined
    ? undefined
    : collectStyles(row).find(
        style => typeof style.height === 'number' && style.flexDirection === 'row'
      );
}

function render(props: ReturnType<typeof buildAndroidWidgetProps>, cell: Cell) {
  const { width, height = 200, rtl = false } = cell;
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

/** The three count rows as text, in rank order, with every state labelled. */
const COUNT_ROWS = ['0', 'Needs input', '1', 'Working', '0', 'Scheduled', '0', 'Idle'];

function propsWithNewest(): ReturnType<typeof buildAndroidWidgetProps> {
  return buildAndroidWidgetProps(
    snapshotFor([{ status: 'busy', statusUpdatedAt: NEWEST_AT }], 0),
    {},
    translate,
    String,
    formatAgo
  );
}

describe('renderActiveAgentsWidget', () => {
  it('returns distinct light and dark layouts through the theme callback', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250 });

    expect(rep.light).toBeDefined();
    expect(rep.dark).toBeDefined();
    expect(rep.light).not.toBe(rep.dark);
    // The app's own palette, not a widget-local one: a card that does not match
    // the app it opens reads as a different product.
    expect(rep.light.props.style?.backgroundColor).toBe(lightColors.background);
    expect(rep.dark.props.style?.backgroundColor).toBe(darkColors.background);
  });

  // The library's flex engine has no reading direction of its own, so every
  // row reverses its own children and every column flips its alignment.
  it('mirrors every row for a right-to-left language', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );

    expect(collectText(render(props, { width: 250, rtl: true }).light)).toEqual([
      'Needs input',
      '1',
      'Working',
      '1',
      'Scheduled',
      '0',
      'Idle',
      '0',
      'Approve',
    ]);
  });

  // Two cells wide and one tall: too narrow to run the states across, so they
  // stack beside the mark and each one keeps its word.
  it('stacks every state beside the mark in a short narrow cell', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );

    expect(collectText(render(props, { width: 150, height: 100 }).light)).toEqual([
      '1',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Approve',
    ]);
  });

  it('draws every state at a small width too, zeros included', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }, { status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 120 });
    const text = collectText(rep.light);

    expect(text).toEqual([
      '1',
      'Needs input',
      '2',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Approve',
    ]);
  });

  it('shows every count, zeros included, at a wide width', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250 });
    const text = collectText(rep.light);

    // The zero row draws so the rows hold still as work moves between states.
    expect(text).toEqual([
      '1',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Approve',
    ]);
  });

  // One cell tall: the counts run in a row instead of stacking. A short row
  // keeps the word only on the ranked state, a wide one labels all three.
  it.each([
    { width: 250, visibleText: ['1', 'Needs input', '1', '0', '0', 'Approve'] },
    {
      width: 340,
      visibleText: ['1', 'Needs input', '1', 'Working', '0', 'Scheduled', '0', 'Idle', 'Approve'],
    },
  ])(
    'runs the counts in a row at width $width and one cell of height',
    ({ width, visibleText }) => {
      const props = buildAndroidWidgetProps(
        snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
        {},
        translate,
        String,
        formatAgo
      );

      expect(collectText(render(props, { width, height: 100 }).light)).toEqual(visibleText);
    }
  );

  // Stale draws its counts and no warning on the short sizes, the same as the
  // iOS card: a fourth line under three counts read as a fourth state. Only the
  // spoken label still says the counts are delayed. The large cell is the one
  // that has a footer to carry the warning.
  it.each([
    {
      width: 120,
      visibleText: ['2', 'Needs input', '4', 'Working', '0', 'Scheduled', '3', 'Idle', 'Approve'],
    },
    {
      width: 250,
      visibleText: ['2', 'Needs input', '4', 'Working', '0', 'Scheduled', '3', 'Idle', 'Approve'],
    },
  ])(
    'speaks stale numeric counts and keeps the deep link at width $width',
    ({ width, visibleText }) => {
      const props = buildAndroidWidgetProps(
        {
          ...snapshotFor([], 0, 'stale'),
          needsInput: 2,
          // The two waiting agents are permission waits: `needsApproval` is the
          // count that draws the chip.
          needsApproval: 2,
          idle: 3,
          running: 4,
        },
        {},
        translate,
        String,
        formatAgo
      );
      const rep = render(props, { width });

      for (const surface of [rep.light, rep.dark]) {
        expect(surface.props.accessibilityLabel).toBe(
          'Updates delayed, 2 Needs input, 4 Working, 3 Idle, Open agents'
        );
        expect(collectText(surface)).toEqual(visibleText);
        expect(surface.props.clickAction).toBe('OPEN_URI');
        expect(surface.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
      }
    }
  );

  it('hides counts and shows expired copy for an expired snapshot', () => {
    const props = buildAndroidWidgetProps(
      {
        ...snapshotFor([{ status: 'busy' }], 0),
        status: 'expired',
        running: 0,
        needsInput: 0,
        idle: 0,
      },
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250 });
    const text = collectText(rep.light);

    expect(text).toEqual(['Status expired']);
  });

  it('draws the newest session line in its own reserved slot', () => {
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'busy' }], 0), {}, translate);

    const text = collectText(render(props, { width: 250 }).light);

    expect(text).toEqual([
      '0',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
      'Newest: Fix the flaky test',
    ]);
  });

  it('reserves the newest slot whether or not it carries a line', () => {
    // The reserved slot is the only box with a fixed height that spans the
    // body: the count rows size themselves, so nothing else matches.
    const reserved = (node: unknown) =>
      collectStyles(node).filter(
        style => typeof style.height === 'number' && style.width === 'match_parent'
      ).length;
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'busy' }], 0), {}, translate);
    const emptySlot = reserved(render(props, { width: 250 }).light);

    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const filledSlot = reserved(render(props, { width: 250 }).light);

    expect(emptySlot).toBe(1);
    expect(filledSlot).toBe(1);
  });

  it('draws the Approve row with its own headless click action', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
      {},
      translate
    );

    const approve = findElement(
      render(props, { width: 250 }).light,
      element => element.props.clickAction === 'approve'
    );

    expect(approve?.props.accessibilityLabel).toBe('Approve');
    expect(collectText(approve)).toEqual(['Approve']);
  });

  // The chip follows the props gate, which only a permission wait raises: a
  // retry (or a question) needs the app, so the tray must not draw an Approve
  // whose press would only open it.
  it('draws no Approve row for a wait the action cannot answer', () => {
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'retry' }]), {}, translate);
    const light = render(props, { width: 250 }).light;

    expect(collectText(light)).toEqual([
      '1',
      'Needs input',
      '0',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
    ]);
    expect(findElement(light, element => element.props.clickAction === 'approve')).toBeUndefined();
  });

  // The chip is the widget's only in-place action, and its whole box is the tap
  // target, so it holds Android's 48 dp minimum instead of sizing to the label.
  it('gives both action chips a full-height tap target', () => {
    const approveProps = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }], 0),
      {},
      translate
    );
    const emptyProps = buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate);

    const chips = [
      findElement(
        render(approveProps, { width: 250 }).light,
        element => element.props.clickAction === 'approve'
      ),
      findElement(
        render(emptyProps, { width: 250 }).light,
        element => element.props.clickAction === 'new-agent'
      ),
    ];

    for (const chip of chips) {
      expect(chip?.props.style?.height).toBeGreaterThanOrEqual(44);
      expect(chip?.props.style?.height).toBeLessThanOrEqual(48);
    }
  });

  it('draws the New agent row for the empty state, and no Approve row', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate);
    const light = render(props, { width: 250 }).light;

    expect(collectText(light)).toEqual(['No agents waiting', 'New agent']);
    expect(
      findElement(light, element => element.props.clickAction === 'new-agent')?.props
        .accessibilityLabel
    ).toBe('New agent');
    expect(findElement(light, element => element.props.clickAction === 'approve')).toBeUndefined();
  });

  it('offers no action rows for a state with nothing to act on', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'waiting'), {}, translate);
    const light = render(props, { width: 250 }).light;

    expect(collectText(light)).toEqual(['Waiting for agents']);
    expect(
      findElement(
        light,
        element =>
          element.props.clickAction !== undefined && element.props.clickAction !== 'OPEN_URI'
      )
    ).toBeUndefined();
  });

  it('labels the whole widget with the Open agents deep-link click action', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250 });

    expect(rep.light.props.clickAction).toBe('OPEN_URI');
    expect(rep.light.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
    expect(rep.dark.props.clickAction).toBe('OPEN_URI');
    expect(rep.dark.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
  });
});

// The nightstand cell: the mark on top, the three counts in the middle, and the
// newest result on the bottom edge. Four cells tall, which reports roughly
// 240–300 dp on Android's launcher grid.
describe('the large widget cell', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('composes the counts and the newest-result footer from real props', () => {
    const rep = render(propsWithNewest(), { width: 250, height: 260 });

    expect(collectText(rep.light)).toEqual([...COUNT_ROWS, 'Newest result', 'Working', AGO]);
    expect(collectText(rep.dark)).toEqual([...COUNT_ROWS, 'Newest result', 'Working', AGO]);
    expect(rep.light.props.clickAction).toBe('OPEN_URI');
    expect(rep.light.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
  });

  // The stale cell keeps its rows: the last known counts are still the counts,
  // and only the third fact is in doubt, so the footer keeps its caption and
  // swaps the result for the warning — the iOS large card's composition.
  it('keeps the rows and swaps the footer result for the stale copy', () => {
    const props = buildAndroidWidgetProps(
      {
        ...snapshotFor([{ status: 'busy', statusUpdatedAt: NEWEST_AT }], 0, 'stale'),
        needsInput: 2,
        idle: 3,
        running: 4,
      },
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250, height: 260 });

    expect(collectText(rep.light)).toEqual([
      '2',
      'Needs input',
      '4',
      'Working',
      '0',
      'Scheduled',
      '3',
      'Idle',
      'Newest result',
      'Updates delayed',
    ]);
  });

  // The lapsed frame is the happy frame with its age retracted: a redraw past
  // the stale window draws the delayed copy in the footer the happy frame
  // reserved, so the mark and the counts do not move and nothing blanks.
  it('draws the delayed copy in the happy frame footer once the data lapses', () => {
    const happy = render(propsWithNewest(), { width: 250, height: 260 });

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
      formatAgo
    );
    vi.useRealTimers();
    const lapsed = render(props, { width: 250, height: 260 });

    expect(collectText(lapsed.light)).toEqual([
      '2',
      'Needs input',
      '4',
      'Working',
      '0',
      'Scheduled',
      '3',
      'Idle',
      'Newest result',
      'Updates delayed',
    ]);
    expect(lapsed.light.props.accessibilityLabel).toBe(
      'Updates delayed, 2 Needs input, 4 Working, 3 Idle, Open agents'
    );
    // The footer box is the one the happy frame reserved, so the column keeps
    // its space-between composition and the counts stay put.
    expect(lapsed.light.props.style?.justifyContent).toBe('space-between');
    expect(happy.light.props.style?.justifyContent).toBe(lapsed.light.props.style?.justifyContent);
  });

  // No counts means one fact only: the status text is the body and there is no
  // footer to carry a third fact.
  it.each([
    ['waiting', 'Waiting for agents'],
    ['empty', 'No agents waiting'],
    ['expired', 'Status expired'],
    ['signed_out', 'Sign in to see agents'],
    ['privacy', 'Open Kilo to see agents'],
  ] as const)('draws %s with no footer', (status, copy) => {
    const props = buildAndroidWidgetProps(
      snapshotFor([], 0, status),
      {},
      translate,
      String,
      formatAgo
    );
    const rep = render(props, { width: 250, height: 260 });

    expect(collectText(rep.light)).toEqual([copy]);
    expect(collectText(rep.dark)).toEqual([copy]);
  });

  it('has no footer for happy work with no row timestamp', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );

    expect(collectText(render(props, { width: 250, height: 260 }).light)).toEqual(COUNT_ROWS);
  });

  // Stale always has something to say, timestamp or not: the footer keeps the
  // caption and states that the counts are the last known ones.
  it('states the stale copy under the caption with no row timestamp', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'busy' }], 0, 'stale'),
      {},
      translate,
      String,
      formatAgo
    );

    expect(collectText(render(props, { width: 250, height: 260 }).light)).toEqual([
      ...COUNT_ROWS,
      'Newest result',
      'Updates delayed',
    ]);
  });

  // A cell one dp short keeps the stack composition: the large bucket is what
  // earns the footer, and below it nothing new is added.
  it('adds the footer only from the large-height bound up', () => {
    const props = propsWithNewest();

    expect(collectText(render(props, { width: 250, height: 219 }).light)).toEqual(COUNT_ROWS);
    expect(collectText(render(props, { width: 250, height: 220 }).light)).toEqual([
      ...COUNT_ROWS,
      'Newest result',
      'Working',
      AGO,
    ]);
  });

  it('mirrors the newest-result row for a right-to-left language', () => {
    const rep = render(propsWithNewest(), { width: 250, height: 260, rtl: true });

    expect(collectText(rep.light)).toEqual([
      'Needs input',
      '0',
      'Working',
      '1',
      'Scheduled',
      '0',
      'Idle',
      '0',
      'Newest result',
      AGO,
      'Working',
    ]);
  });
});

// The scheduled count row: the marker takes its own color, the wake rides beside
// the row, and the slot the wake fills is reserved whether or not it is known.
describe('the scheduled count row', () => {
  /** Two hours ahead of the suite's clock, so the stub formatter echoes it. */
  const WAKE = new Date(NOW + 7_200_000).toISOString();

  function propsFor(scheduledAt?: string) {
    return buildAndroidWidgetProps(
      snapshotFor(
        [{ status: 'scheduled', ...(scheduledAt === undefined ? {} : { scheduledAt }) }],
        0
      ),
      {},
      translate,
      String,
      formatAgo
    );
  }

  it('gives the scheduled marker its own color instead of the idle outline', () => {
    const rep = render(propsFor(), { width: 250 });
    const light = collectStyles(rep.light);
    const dark = collectStyles(rep.dark);

    // Filled in the muted-soft tone the session list's scheduled clock uses.
    expect(light.some(style => style.backgroundColor === lightColors.mutedSoft)).toBe(true);
    expect(dark.some(style => style.backgroundColor === darkColors.mutedSoft)).toBe(true);
    // The idle marker stays an outline, so the two greys never read alike.
    expect(light.some(style => style.borderColor === lightColors.foreground)).toBe(true);
  });

  it('draws the wake time beside the scheduled row', () => {
    const row = countRowFor(render(propsFor(WAKE), { width: 250 }).light, 'Scheduled');

    expect(collectText(row)).toEqual(['1', 'Scheduled', formatAgo(WAKE)]);
  });

  it('reserves the wake slot whether or not a wake is known', () => {
    const withWakeRow = countRowFor(render(propsFor(WAKE), { width: 250 }).light, 'Scheduled');
    const withoutWakeRow = countRowFor(render(propsFor(), { width: 250 }).light, 'Scheduled');
    const withWake = wakeSlotStyle(withWakeRow);
    const withoutWake = wakeSlotStyle(withoutWakeRow);

    expect(withWake?.height).toBeGreaterThan(0);
    expect(withoutWake?.height).toBe(withWake?.height);
    // The slot is reserved empty: no time text until the CLI reports one.
    expect(collectText(withoutWakeRow)).toEqual(['1', 'Scheduled']);
  });
});
