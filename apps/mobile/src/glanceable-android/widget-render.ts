/**
 * The Android widget render, split out of `android-sink.ts` so the sink keeps
 * the card's lifecycle and this module keeps the widget's props and redraw.
 *
 * Android owns the widget expiry, so a delayed render must re-read the current
 * snapshot and its deadline instead of drawing cached props.
 */

import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { requestWidgetUpdate } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { formatGlanceableCount } from '@/lib/glanceable/count-format';
import {
  getHomeWidgetDataForSnapshot,
  getLastHomeWidgetData,
} from '@/lib/glanceable/home-widget-data';

import { renderActiveAgentsWidget, WIDGET_NAME } from './active-agents-widget';
import { formatGlanceableAgo, formatGlanceableClock, isWidgetRtl } from './count-format';
import { getStoredWidgetSnapshot } from './live-update';
import { type AndroidWidgetProps, buildCurrentWidgetProps } from './widget-props';

/** Translated copy for the widget and the card's terminal line. */
export function translate(key: string): string {
  return i18n.t(key);
}

let lastPublishedSnapshot: GlanceableAgentsSnapshot | null = null;

/** Remember the snapshot the last publication carried, for a later redraw. */
export function noteWidgetSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  lastPublishedSnapshot = snapshot;
}

/** The last published snapshot, or the one the native mirror holds after a JS restart. */
export function lastWidgetSnapshot(): GlanceableAgentsSnapshot | null {
  return lastPublishedSnapshot ?? getStoredWidgetSnapshot();
}

/** The widget props for `snapshot`, with the deadline and staleness checks every redraw runs. */
export function widgetPropsFor(snapshot: GlanceableAgentsSnapshot): AndroidWidgetProps {
  return buildCurrentWidgetProps(
    snapshot,
    translate,
    formatGlanceableCount,
    formatGlanceableAgo,
    formatGlanceableClock,
    getHomeWidgetDataForSnapshot(snapshot)
  );
}

/** A delayed render must check the current snapshot and its deadline, not cached props. */
export function getCurrentWidgetProps(): AndroidWidgetProps | null {
  const snapshot = lastPublishedSnapshot ?? getLastHomeWidgetData()?.snapshot ?? null;
  return snapshot === null ? null : widgetPropsFor(snapshot);
}

export function renderWidgetNow(props: AndroidWidgetProps): void {
  void requestWidgetUpdate({
    widgetName: WIDGET_NAME,
    renderWidget: info =>
      renderActiveAgentsWidget(getCurrentWidgetProps() ?? props, info, isWidgetRtl()),
  });
}

/** Test-only: drop the remembered snapshot without touching the native mirror. */
export function _resetWidgetRenderForTests(): void {
  lastPublishedSnapshot = null;
}
