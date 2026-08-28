import { AppState } from 'react-native';
import {
  registerWidgetTaskHandler,
  type WidgetTaskHandlerProps,
} from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { androidSink, getCurrentWidgetProps, handleAppStateActive } from './android-sink';
import {
  buildAndroidWidgetProps,
  buildExpiredWidgetProps,
  buildGenericWidgetProps,
} from './widget-props';

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

function translate(key: string): string {
  return i18n.t(key);
}

registerWidgetTaskHandler(async (task: WidgetTaskHandlerProps) => {
  const { widgetInfo, renderWidget } = task;

  let props = getCurrentWidgetProps();
  if (props === null) {
    // Headless restarts have no live widget props; restore the existing mirror.
    await restorePersistedGlanceable();
    const snapshot = getLastGlanceableSnapshot();
    if (snapshot === null) {
      props = buildGenericWidgetProps(translate);
    } else if (
      snapshot.status !== 'privacy' &&
      snapshot.status !== 'signed_out' &&
      Date.parse(snapshot.expiresAt) <= Date.now()
    ) {
      props = buildExpiredWidgetProps(snapshot, translate);
    } else {
      props = buildAndroidWidgetProps(snapshot, {}, translate);
    }
    // A live publish during restoration owns the widget.
    props = getCurrentWidgetProps() ?? props;
  }
  renderWidget(renderActiveAgentsWidget(props, widgetInfo));
});
