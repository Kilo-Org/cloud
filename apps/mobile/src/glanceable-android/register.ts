import {
  registerWidgetTaskHandler,
  type WidgetTaskHandlerProps,
} from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { openGlanceableAgents } from '@/lib/glanceable/open-agents';

import { OPEN_AGENTS_CLICK, renderActiveAgentsWidget } from './active-agents-widget';
import { androidSink, getCurrentWidgetProps, handleWidgetOpenTap } from './android-sink';
import { buildGenericWidgetProps } from './widget-props';

// Register the Android sink at import time. The main-app import of the local
// live-update module loads this file, so the sink subscribes before any widget
// render. No React dependency here: the publisher is plain state.
registerGlanceableSink(androidSink);

function translate(key: string): string {
  return i18n.t(key);
}

registerWidgetTaskHandler(async (task: WidgetTaskHandlerProps) => {
  const { widgetInfo, widgetAction, clickAction, renderWidget } = task;

  if (widgetAction === 'WIDGET_CLICK') {
    if (clickAction === OPEN_AGENTS_CLICK) {
      openGlanceableAgents();
      await handleWidgetOpenTap();
    }
    return;
  }

  const props = getCurrentWidgetProps() ?? buildGenericWidgetProps(translate);
  renderWidget(renderActiveAgentsWidget(props, widgetInfo));
});
