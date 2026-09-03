import { AppState } from 'react-native';
import {
  registerWidgetTaskHandler,
  type WidgetTaskHandlerProps,
} from 'react-native-android-widget';

import { i18n } from '@/i18n';
import {
  getLiveActivityEnabled,
  subscribeLiveActivityEnabled,
} from '@/lib/glanceable/live-activity-switch';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { androidSink, getCurrentWidgetProps, handleAppStateActive } from './android-sink';
import { formatGlanceableCount } from './count-format';
import { getStoredWidgetSnapshot, setWidgetSnapshot } from './live-update';
import { buildCurrentWidgetProps, buildGenericWidgetProps } from './widget-props';

// Register the Android sink at import time. The main-app import of the local
// live-update module loads this file, so the sink subscribes before any widget
// render. No React dependency here: the publisher is plain state.
registerGlanceableSink(androidSink);

// The permission alert needs a foreground Activity; RN Android's AlertModule
// no-ops in headless JS. Show it when the app returns to the foreground instead.
AppState.addEventListener('change', state => {
  if (state === 'active') {
    void handleAppStateActive();
  }
});

// Turning the in-app switch off must clear the Live Update already in the
// shade, not just stop the next start. `startOrUpdate` holds the guard for
// everything after this.
let liveUpdateAllowed = getLiveActivityEnabled();
subscribeLiveActivityEnabled(() => {
  const next = getLiveActivityEnabled();
  if (liveUpdateAllowed && !next) {
    androidSink.endImmediate();
  }
  liveUpdateAllowed = next;
});

function translate(key: string): string {
  return i18n.t(key);
}

registerWidgetTaskHandler(async (task: WidgetTaskHandlerProps) => {
  const { widgetInfo, renderWidget } = task;

  // Re-read native storage even in a live process. An old alarm can already have
  // queued this task when newer work or a privacy blank replaces its deadline.
  const stored = getStoredWidgetSnapshot();
  let props =
    stored === null ? getCurrentWidgetProps() : buildCurrentWidgetProps(stored, translate, formatGlanceableCount);
  if (props === null) {
    // Migrate the existing mirror when this installation has no native snapshot yet.
    await restorePersistedGlanceable();
    const snapshot = getLastGlanceableSnapshot();
    if (snapshot !== null && getCurrentWidgetProps() === null) {
      setWidgetSnapshot(snapshot);
    }
    props =
      snapshot === null
        ? buildGenericWidgetProps(translate, formatGlanceableCount)
        : buildCurrentWidgetProps(snapshot, translate, formatGlanceableCount);
    // A live publish during restoration owns the widget.
    props = getCurrentWidgetProps() ?? props;
  }
  renderWidget(renderActiveAgentsWidget(props, widgetInfo));
});
