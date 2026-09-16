import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { getLastGlanceableSnapshot } from './persist';
import { GlanceablePublisher } from './publisher';
import { getGlanceableSinks } from './sink-registry';
import { recordWaitingAsk, type WaitingAsk } from './waiting-ask';

export type CreateGlanceablePublisherOptions = {
  /**
   * Replace the ask write for this publisher. The post-answer refresh passes
   * one so the tray's row can never re-offer the ask its own refresh answered
   * while the control plane's status sync lands (see `refreshGlanceableSnapshot`).
   */
  onWaitingAskChange?: (ask: WaitingAsk | null) => void;
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
    onWaitingAskChange: options.onWaitingAskChange ?? recordWaitingAsk,
  });
}
