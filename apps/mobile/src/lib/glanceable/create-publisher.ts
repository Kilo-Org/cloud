import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { getLastGlanceableSnapshot } from './persist';
import { GlanceablePublisher } from './publisher';
import { getGlanceableSinks } from './sink-registry';
import { recordWaitingAsk } from './waiting-ask';

export type CreateGlanceablePublisherOptions = {
  /**
   * The session whose ask the post-answer refresh ended. Its tray row can still
   * read permission/question while the control plane's status sync lands, so
   * the ask selection skips it and the next waiting session is recorded in its
   * place. Absent while the ask still waits (see `refreshGlanceableSnapshot`
   * and `skipWaitingAskSessionId`).
   */
  skipWaitingAskSessionId?: string;
};

/**
 * The one wiring of the glanceable publisher: the registered sinks, the
 * persisted revision seed, the terminal-blank and lost-org fences, and the
 * waiting-ask record. The app mount and the headless refresh both build their
 * publisher here, so neither can drift from the other's options.
 */
export function createGlanceablePublisher(
  options: CreateGlanceablePublisherOptions = {}
): GlanceablePublisher {
  return new GlanceablePublisher({
    sinks: getGlanceableSinks(),
    initial: getLastGlanceableSnapshot(),
    terminalBlankEpoch: getTerminalBlankEpoch,
    orgLost: isGlanceableOrgLost,
    onWaitingAskChange: recordWaitingAsk,
    skipWaitingAskSessionId: options.skipWaitingAskSessionId,
  });
}
