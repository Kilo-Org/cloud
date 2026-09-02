import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';

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
