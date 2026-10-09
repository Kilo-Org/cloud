import { buildHomeWidgetData, type HomeWidgetSessionRow } from '@kilocode/app-shared/home-widget';
import { expect } from 'vitest';

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
  'glanceable.empty': 'No work in progress',
  'glanceable.waiting': 'Waiting for agents',
  'glanceable.signedOut': 'Sign in to see agents',
  'glanceable.privacy': 'Open Kilo to see agents',
  'glanceable.checked': 'Checked',
  'glanceable.lastKnown': 'Last known',
  'glanceable.awaitingUpdate': 'Awaiting update',
  'glanceable.nextRun': 'Next run',
  'glanceable.newAgent': 'New agent',
  'common.approve': 'Approve',
  'glanceable.approving': 'Approving…',
  'glanceable.couldNotApprove': 'Could not approve',
  'agentChat.permissionCard.title': 'Permission required',
  'glanceable.answerNeeded': 'Answer needed',
  'glanceable.waitingToRetry': 'Waiting to retry',
  'glanceable.openAgents': 'Open agents',
};
export const translate = (key: string) => COPY[key] ?? key;

// Launcher-reported dp frames, including the shallow landscape variants.
export const CELLS = [
  [172, 104],
  [266, 104],
  [360, 104],
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
] as const;

export type Element = {
  props: {
    children?: unknown;
    text?: string;
    maxLines?: number;
    clickAction?: string;
    clickActionData?: { uri?: string };
    accessibilityLabel?: string;
    style?: {
      height?: string | number;
      width?: string | number;
      flex?: number;
      flexDirection?: string;
      flexGap?: number;
      padding?: number;
      fontSize?: number;
      backgroundColor?: string;
      textAlign?: string;
    };
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

/** Check emitted native slot budgets, including fallback-script font padding. Not pixel measurement. */
export function minimumHeight(root: unknown): number {
  if (root === null || typeof root !== 'object') {
    return 0;
  }
  if (Array.isArray(root)) {
    return root.reduce((sum: number, child) => sum + minimumHeight(child), 0);
  }
  const element = root as Element;
  const { style = {}, text: value, maxLines = 1 } = element.props;
  if (value !== undefined) {
    if (value === '') {
      return 0;
    }
    const tall = /[\u0600-\u08FF\u0900-\u0DFF]/u.test(value);
    return Math.ceil((style.fontSize ?? 14) * (tall ? 1.62 : 1.32)) * maxLines;
  }
  const children = (
    Array.isArray(element.props.children)
      ? element.props.children.flat(Infinity)
      : [element.props.children]
  ).filter(child => child != null);
  const heights = children.map(child => minimumHeight(child));
  const content =
    style.flexDirection === 'row'
      ? Math.max(0, ...heights)
      : heights.reduce((sum, height) => sum + height, 0) +
        Math.max(0, heights.length - 1) * (style.flexGap ?? 0);
  if (typeof style.height === 'number') {
    expect(
      content,
      JSON.stringify({ style, text: nodes(element).map(node => node.props.text) })
    ).toBeLessThanOrEqual(style.height - 2 * (style.padding ?? 0));
    return style.height;
  }
  return content + 2 * (style.padding ?? 0);
}
