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

export function snapshotFor(
  sessions: { status: string }[] = [
    { status: 'question' },
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

export async function runWidgetTask(handler: WidgetTaskHandler, width: number) {
  const renders: WidgetRepresentation[] = [];
  await handler({
    widgetAction: 'WIDGET_UPDATE',
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
  const [rendered] = renders;
  if (rendered === undefined || !('light' in rendered)) {
    throw new Error('The widget task did not render its themed layouts');
  }
  return rendered;
}

export function collectText(node: ReactNode): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => collectText(child));
  }
  if (!isValidElement<{ text?: string; children?: ReactNode }>(node)) {
    return [];
  }
  const text = node.props.text === undefined ? [] : [node.props.text];
  return [...text, ...collectText(node.props.children)];
}

