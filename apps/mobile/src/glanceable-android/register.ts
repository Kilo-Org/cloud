import { AppState } from 'react-native';
import {
  registerWidgetTaskHandler,
  type WidgetTaskHandlerProps,
} from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { openGlanceableAgents } from '@/lib/glanceable/open-agents';

import { OPEN_AGENTS_CLICK, renderActiveAgentsWidget } from './active-agents-widget';
import {
  androidSink,
  getCurrentWidgetProps,
  handleAppStateActive,
  handleWidgetOpenTap,
} from './android-sink';
import { buildAndroidWidgetProps, buildGenericWidgetProps } from './widget-props';

// Register the Android sink at import time. The main-app import of the local
// live-update module loads this file, so the sink subscribes before any widget
// render. No React dependency here: the publisher is plain state.
registerGlanceableSink(androidSink);

function translate(key: string): string {
  return i18n.t(key);
}

// Restart a permission-denied pending start when the app returns to the
// foreground and notification permission is now granted. Plain AppState, no
// React component: this module loads once for the whole process.
AppState.addEventListener('change', state => {
  if (state === 'active') {
    void handleAppStateActive();
  }
});

registerWidgetTaskHandler(async (task: WidgetTaskHandlerProps) => {
  const { widgetInfo, widgetAction, clickAction, renderWidget } = task;

  if (widgetAction === 'WIDGET_CLICK') {
    if (clickAction === OPEN_AGENTS_CLICK) {
      openGlanceableAgents();
      await handleWidgetOpenTap();
    }
    return;
  }

  // A process restart loses the in-memory widget props. Render them directly
  // when present: a live redraw's in-memory props are newer than any
  // SecureStore record, so a redraw must never restore a stale snapshot. The
  // persisted snapshot is restored only on first load, when no in-memory props
  // exist, and the generic empty placeholder covers a never-persisted state.
  const liveProps = getCurrentWidgetProps();
  if (liveProps !== null) {
    renderWidget(renderActiveAgentsWidget(liveProps, widgetInfo));
    return;
  }
  await restorePersistedGlanceable();
  const snapshot = getLastGlanceableSnapshot();
  const props =
    snapshot === null
      ? buildGenericWidgetProps(translate)
      : buildAndroidWidgetProps(snapshot, {}, translate);
  renderWidget(renderActiveAgentsWidget(props, widgetInfo));
});
