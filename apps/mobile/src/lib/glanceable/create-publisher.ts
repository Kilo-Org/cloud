import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { getLastGlanceableSnapshot } from './persist';
import { GlanceablePublisher } from './publisher';
import { getGlanceableSinks } from './sink-registry';
import { recordWaitingAsk } from './waiting-ask';

/**
 * The one wiring of the glanceable publisher: the registered sinks, the
 * persisted revision seed, the terminal-blank and lost-org fences, and the
 * waiting-ask record. The app mount and the headless refresh both build their
 * publisher here, so neither can drift from the other's options.
 */
export function createGlanceablePublisher(): GlanceablePublisher {
  return new GlanceablePublisher({
    sinks: getGlanceableSinks(),
    initial: getLastGlanceableSnapshot(),
    terminalBlankEpoch: getTerminalBlankEpoch,
    orgLost: isGlanceableOrgLost,
    onWaitingAskChange: recordWaitingAsk,
  });
}
