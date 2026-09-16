import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { isValidElement, type ReactNode } from 'react';
import { type WidgetRepresentation, type WidgetTaskHandler } from 'react-native-android-widget';
import { vi } from 'vitest';

/** Shared fixtures for the widget-task suites. Mocks stay in the test files. */

export const NOW = 1_750_000_000_000;

/** The persisted-snapshot mirror the suites hand to `_setSecureStoreForTests`. */
export const store = new Map<string, string>();
export const secureStore = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
};

/**
 * The default tray: one permission wait — the only kind the widget can answer
 * in place — one retry wait it cannot, and two working agents. Two agents wait,
 * so the counts read 2 and the Approve chip is offered for the permission.
 */
export function snapshotFor(
  sessions: { status: string }[] = [
    { status: 'permission' },
    { status: 'retry' },
    { status: 'busy' },
    { status: 'busy' },
  ],
  status: GlanceableAgentsSnapshot['status'] = 'happy'
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    status,
    userId: 'u1',
    organizationId: null,
    now: NOW,
  });
}

async function runTask(
  handler: WidgetTaskHandler,
  width: number,
  action: Pick<Parameters<WidgetTaskHandler>[0], 'widgetAction' | 'clickAction'>
): Promise<WidgetRepresentation[]> {
  const renders: WidgetRepresentation[] = [];
  await handler({
    widgetAction: action.widgetAction,
    clickAction: action.clickAction,
    widgetInfo: {
      widgetName: 'ActiveAgentsWidget',
      widgetId: 1,
      width,
      height: 200,
      screenInfo: {
        screenWidthDp: 400,
        screenHeightDp: 800,
        density: 2,
        densityDpi: 320,
      },
    },
    renderWidget: widget => {
      renders.push(widget);
    },
  });
  return renders;
}

export async function runWidgetTask(handler: WidgetTaskHandler, width: number) {
  const renders = await runTask(handler, width, { widgetAction: 'WIDGET_UPDATE' });
  const [rendered] = renders;
  if (rendered === undefined || !('light' in rendered)) {
    throw new Error('The widget task did not render its themed layouts');
  }
  return rendered;
}

/**
 * Run a task for one of the widget's own click actions. A custom `clickAction`
 * launches a headless task, and the handler redraws per step, so the caller
 * gets every render in order.
 */
/** The themed half of a representation; the task always draws both layouts. */
export type ThemedWidgets = { light: React.JSX.Element; dark: React.JSX.Element | null };

export async function runWidgetClickTask(
  handler: WidgetTaskHandler,
  width: number,
  clickAction: string
): Promise<ThemedWidgets[]> {
  const renders = await runTask(handler, width, { widgetAction: 'WIDGET_CLICK', clickAction });
  return renders.flatMap(rendered =>
    'light' in rendered ? [{ light: rendered.light, dark: rendered.dark }] : []
  );
}

export function collectText(node: ReactNode | undefined): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => collectText(child));
  }
  if (!isValidElement<{ text?: string; children?: ReactNode }>(node)) {
    return [];
  }
  const text = node.props.text === undefined ? [] : [node.props.text];
  return [...text, ...collectText(node.props.children)];
}
