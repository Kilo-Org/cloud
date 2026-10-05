/* eslint-disable max-lines -- one suite covering every size bucket and the state matrix through a shared mock-element tree harness */
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import {
  LARGE_MIN_HEIGHT_DP,
  renderActiveAgentsWidget,
  ROW_LABEL_MIN_WIDTH_DP,
} from './active-agents-widget';
import { buildAndroidWidgetProps, buildCurrentWidgetProps } from './widget-props';
import widgetConfig from './widget-config.json';

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
    allowFontScaling?: boolean;
    maxLines?: number;
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

const NEW_AGENT_URI = 'kiloapp:///cloud/sessions/new';

/** The New agent chip: the one element that deep-links to the new-session screen. */
function isNewAgentChip(element: MockElement): boolean {
  return element.props.clickActionData?.uri === NEW_AGENT_URI;
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

/** Every text-bearing element, in tree order. Only `TextWidget` carries `text`. */
function collectTextElements(node: unknown): MockElement[] {
  const found: MockElement[] = [];
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
    if (typeof element.props.text === 'string') {
      found.push(element);
    }
    visit(element.props.children);
  };
  visit(node);
  return found;
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
  // stack beside the mark and each one keeps its word. The 48 dp chip cannot
  // fit under four stacked rows in a ~100 dp cell — it was cut at the cell edge
  // — so the short narrow bucket drops it and the whole surface keeps its own
  // deep link. The chip returns as soon as the cell is tall enough.
  it('stacks every state beside the mark in a short narrow cell, without the clipped chip', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'permission' }, { status: 'busy' }], 0),
      {},
      translate,
      String,
      formatAgo
    );

    const rep = render(props, { width: 150, height: 100 });
    expect(collectText(rep.light)).toEqual([
      '1',
      'Needs input',
      '1',
      'Working',
      '0',
      'Scheduled',
      '0',
      'Idle',
    ]);
    expect(
      findElement(rep.light, element => element.props.clickAction === 'approve')
    ).toBeUndefined();
    // The body still opens Kilo, so the dropped chip leaves no dead tap.
    expect(rep.light.props.clickAction).toBe('OPEN_URI');
    expect(rep.light.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });

    // A taller cell has room for the chip: at 200 dp the stack bucket fits the
    // rows and the 48 dp target.
    const taller = render(props, { width: 150, height: 200 });
    expect(collectText(taller.light)).toContain('Approve');
  });

  // The empty and idle-only states were the ones whose New agent chip was cut
  // at the cell edge. A one-row cell (a Pixel launcher reports 104 dp) fits the
  // chip under one line of copy, so the copy gives up its second line before
  // the cell gives up its only action. A cell too short even for that drops
  // the chip, and the deep link still opens Kilo.
  it.each([
    { width: 150, height: 100 },
    { width: 360, height: 104 },
  ])('keeps the New agent chip under one line of copy in a $width x $height empty cell', cell => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate);
    const light = render(props, cell).light;

    expect(collectText(light)).toEqual(['No agents waiting', 'New agent']);
    expect(
      findElement(light, element => element.props.text === 'No agents waiting')?.props.maxLines
    ).toBe(1);
    expect(findElement(light, isNewAgentChip)?.props.style?.height).toBe(48);
  });

  it('drops the New agent chip rather than clipping it in a cell too short for it', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'empty'), {}, translate);

    const short = render(props, { width: 150, height: 70 }).light;
    expect(collectText(short)).toEqual(['No agents waiting']);
    expect(findElement(short, isNewAgentChip)).toBeUndefined();
    expect(short.props.clickAction).toBe('OPEN_URI');

    // A cell with room for both keeps the second line of copy and the chip.
    const tall = render(props, { width: 250, height: 200 }).light;
    expect(collectText(tall)).toEqual(['No agents waiting', 'New agent']);
    expect(
      findElement(tall, element => element.props.text === 'No agents waiting')?.props.maxLines
    ).toBe(2);
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

  // One cell tall: the counts run in a row instead of stacking. A phone-wide
  // row (four cells, about 360 dp) clipped the fourth label, so only a row
  // wider than a phone labels all four; a shorter row keeps the ranked word.
  it.each([
    { width: 250, visibleText: ['1', 'Needs input', '1', '0', '0', 'Approve'] },
    { width: 360, visibleText: ['1', 'Needs input', '1', '0', '0', 'Approve'] },
    {
      width: 440,
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
      findElement(render(emptyProps, { width: 250 }).light, isNewAgentChip),
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
    const chip = findElement(light, isNewAgentChip);
    expect(chip?.props.accessibilityLabel).toBe('New agent');
    // Starting an agent needs the composer, so the chip is a plain deep link to
    // the new-session screen that the host opens without a headless task.
    expect(chip?.props.clickAction).toBe('OPEN_URI');
    expect(findElement(light, element => element.props.clickAction === 'approve')).toBeUndefined();
  });

  it('offers no action rows for a state with nothing to act on', () => {
    const props = buildAndroidWidgetProps(snapshotFor([], 0, 'waiting'), {}, translate);
    const light = render(props, { width: 250 }).light;

    expect(collectText(light)).toEqual(['Waiting for agents']);
    expect(
      findElement(light, element => element !== light && element.props.clickAction !== undefined)
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

  // A widget cell is a fixed frame with no scrolling and no reflow, so text that
  // scaled with the system font size pushed the mark, the reserved newest line,
  // and the 48 dp chip outside it at Large system text. Every label is pinned to
  // its own dp size instead, in every bucket and on both themes.
  it('pins every label to the cell size so Large system text cannot overflow it', () => {
    const wake = new Date(NOW + 7_200_000).toISOString();
    setSurfaceExtras({ newestSessionTitle: 'Fix the flaky test', actionFeedback: null });
    const props = buildAndroidWidgetProps(
      snapshotFor(
        [
          { status: 'permission' },
          { status: 'busy', statusUpdatedAt: NEWEST_AT },
          { status: 'scheduled', scheduledAt: wake },
        ],
        0
      ),
      {},
      translate,
      String,
      formatAgo
    );

    // One cell of each bucket, and the resize cap's own corner.
    for (const cell of [
      { width: 120, height: 100 },
      { width: 250, height: 100 },
      { width: 250, height: 200 },
      { width: 250, height: 260 },
      { width: 400, height: 400 },
    ]) {
      const rep = render(props, cell);
      for (const [theme, surface] of Object.entries(rep)) {
        const labels = collectTextElements(surface);
        expect(labels.length).toBeGreaterThan(0);
        for (const label of labels) {
          expect(
            label.props.allowFontScaling,
            `${theme} text \`${label.props.text}\` at ${cell.width}x${cell.height}`
          ).toBe(false);
        }
      }
    }
  });
});

// The labelled row and the large card are unreachable if the resize cap stops a
// step short of their bounds, however correct the buckets are.
describe('the widget resize cap', () => {
  it('reaches the labelled row and the large card', () => {
    const widget = widgetConfig.widgets.find(entry => entry.name === 'ActiveAgentsWidget');

    expect(Number.parseInt(widget?.maxResizeWidth ?? '0', 10)).toBeGreaterThanOrEqual(
      ROW_LABEL_MIN_WIDTH_DP
    );
    expect(Number.parseInt(widget?.maxResizeHeight ?? '0', 10)).toBeGreaterThanOrEqual(
      LARGE_MIN_HEIGHT_DP
    );
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
