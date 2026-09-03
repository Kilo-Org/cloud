import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';

import { iosSink } from './ios-sink';

// Registers the iOS Live Activity and widget sink at import time. The root
// layout imports this file, so the surface lifecycle subscribes to the
// publisher for the whole process on both platforms. Never create a React
// dependency here: the publisher is plain state, and widgets get translated
// copy through the sink, not through a mounted component tree.
registerGlanceableSink(iosSink);
