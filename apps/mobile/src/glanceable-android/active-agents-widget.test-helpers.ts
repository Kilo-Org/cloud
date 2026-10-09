import { buildHomeWidgetData, type HomeWidgetSessionRow } from '@kilocode/app-shared/home-widget';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { type AndroidWidgetProps, buildAndroidWidgetProps } from './widget-props';

/** Shared fixtures and tree walkers for the widget layout suite. Mocks stay in the test file. */

export const NOW = 1_750_000_000_000;
export const WAKE = new Date(NOW + 7_200_000).toISOString();
const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'common.working': 'Working',
  'common.scheduled': 'Scheduled',
  'common.idle': 'Idle',
  'common.agent': 'Agent',
  'common.recent': 'Recent',
  'glanceable.empty': 'No work in progress',
  'home.noLiveSessions': 'Nothing running right now',
  'glanceable.waiting': 'Updating agents',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.checked': 'Checked',
  'glanceable.lastKnown': 'Last known',
  'glanceable.awaitingUpdate': 'Awaiting update',
  'glanceable.nextRun': 'Next run',
  'glanceable.newAgent': 'New agent',
  'glanceable.waitingForYou': 'Waiting for you',
  'glanceable.nextScheduled': 'Next scheduled',
  'common.approve': 'Approve',
  'glanceable.approving': 'Approving…',
  'glanceable.couldNotApprove': 'Could not approve',
  'glanceable.approveFailed': "Couldn't approve. Tap Approve to try again.",
  'agentChat.permissionCard.title': 'Permission required',
  'glanceable.answerNeeded': 'Answer needed',
  'glanceable.waitingToRetry': 'Waiting to retry',
  'glanceable.openAgents': 'Open agents',
};
export const translate = (key: string) => COPY[key] ?? key;

/** The design frames, then launcher-reported dp cells including the landscape bands. */
export const DESIGN = {
  small: [170, 170],
  medium: [364, 170],
  large: [364, 382],
  row: [360, 104],
  narrow: [172, 104],
  landscape: [627, 62],
} as const;
export const CELLS = [
  [172, 104],
  [266, 104],
  [360, 104],
  [172, 135],
  [172, 224],
  [266, 224],
  [360, 224],
  [172, 344],
  [266, 344],
  [360, 344],
  [360, 464],
  [307, 62],
  [467, 62],
  [627, 62],
  [307, 135],
  [467, 135],
  [627, 135],
  [307, 208],
  [467, 208],
  [627, 208],
  [627, 281],
  ...Object.values(DESIGN),
] as const;

type Style = {
  height?: string | number;
  width?: string | number;
  marginLeft?: number;
  marginTop?: number;
  flex?: number;
  flexDirection?: string;
  flexGap?: number;
  fontSize?: number;
  fontWeight?: string;
  backgroundColor?: string;
  textAlign?: string;
  rotation?: number;
};
export type Element = {
  key?: string | null;
  props: {
    children?: unknown;
    text?: string;
    maxLines?: number;
    truncate?: string;
    clickAction?: string;
    clickActionData?: { uri?: string; approvalKey?: string | null };
    accessibilityLabel?: string;
    style?: Style;
  };
};
export function nodes(root: unknown): Element[] {
  if (root === null || typeof root !== 'object') {
    return [];
  }
  if (Array.isArray(root)) {
    return root.flatMap(child => nodes(child));
  }
  const element = root as Element;
  return [element, ...nodes(element.props.children)];
}
/** The canvas's absolutely placed children. */
export function placed(root: Element): Element[] {
  return [root.props.children]
    .flat(Infinity)
    .filter((child): child is Element => child !== null && typeof child === 'object');
}
export type Rect = { x: number; y: number; width: number; height: number };
export function rectOf(node: Element): Rect {
  const { marginLeft = 0, marginTop = 0, width, height } = node.props.style ?? {};
  return {
    x: marginLeft,
    y: marginTop,
    width: typeof width === 'number' ? width : Number.NaN,
    height: typeof height === 'number' ? height : Number.NaN,
  };
}
export function hasKey(root: Element, key: string): boolean {
  return placed(root).some(node => node.key === key);
}
/** The placed child with `key`; a missing one fails the test that asked for it. */
export function byKey(root: Element, key: string): Element {
  const found = placed(root).find(node => node.key === key);
  if (found === undefined) {
    throw new Error(`no placed ${key}`);
  }
  return found;
}
export function propsFor(
  sessions: HomeWidgetSessionRow[],
  status?: Parameters<typeof buildHomeWidgetData>[0]['status'],
  copy = translate
) {
  const data = buildHomeWidgetData({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    ...(status ? { status } : {}),
  });
  return buildAndroidWidgetProps(data.snapshot, {}, copy, String, String, () => '8:00 PM', data);
}
/** `size` is a launcher-reported `[width, height]` dp frame. */
export function render(props: AndroidWidgetProps, size: readonly [number, number], rtl = false) {
  const [width, height] = size;
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
  ) as { light: Element; dark: Element };
}
export function texts(root: Element) {
  return nodes(root).flatMap(node => (node.props.text ? [node.props.text] : []));
}
