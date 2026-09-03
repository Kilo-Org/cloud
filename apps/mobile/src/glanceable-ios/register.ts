import { i18n } from '@/i18n';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import {
  getLiveActivityEnabled,
  subscribeLiveActivityEnabled,
} from '@/lib/glanceable/live-activity-switch';

import { refreshActiveAgentsLiveActivityCopy } from './active-agents-live-activity';
import { refreshActiveAgentsWidgetCopy } from './active-agents-widget';
import { iosSink } from './ios-sink';
import { ensureWidgetLogo } from './widget-logo';

// Registers the iOS Live Activity and widget sink at import time. The root
// layout imports this file, so the surface lifecycle subscribes to the
// publisher for the whole process on both platforms. Never create a React
// dependency here: the publisher is plain state, and widgets get translated
// copy through the sink, not through a mounted component tree.
registerGlanceableSink(iosSink);

// Copy the Kilo mark into the shared app group so the widget extension can read
// it. Fire and forget: it lands long before the first snapshot arrives, and a
// failure only costs the logo.
void ensureWidgetLogo();

// The layouts bake their copy in at import, when i18n still holds English: the
// stored language is applied a few ticks later. Re-bake on every language
// change so both the Live Activity and the widget gallery placeholder follow
// the user's language.
i18n.on('languageChanged', () => {
  refreshActiveAgentsLiveActivityCopy();
  refreshActiveAgentsWidgetCopy();
});

// Turning the in-app switch off must clear the activity already on the Lock
// Screen, not just stop the next start. `startOrUpdate` holds the guard for
// everything after this.
let liveActivityAllowed = getLiveActivityEnabled();
subscribeLiveActivityEnabled(() => {
  const next = getLiveActivityEnabled();
  if (liveActivityAllowed && !next) {
    iosSink.endImmediate();
  }
  liveActivityAllowed = next;
});
