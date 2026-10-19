import { recordSelectedAsk, subscribeAskBound } from './ask-binding';
import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { getLastGlanceableSnapshot } from './persist';
import { GlanceablePublisher } from './publisher';
import { getGlanceableSinks } from './sink-registry';

export type CreateGlanceablePublisherOptions = {
  /**
   * The session whose ask the post-answer refresh ended. Its tray row can still
   * read permission/question while the control plane's status sync lands, so
   * the ask selection skips it and the next waiting session is recorded in its
   * place. Absent while the ask still waits (see `refreshGlanceableSnapshot`
   * and `skipWaitingAskSessionId`).
   */
  skipWaitingAskSessionId?: string;
  /**
   * Whether the publisher redraws the frame it emitted when the recorded ask's
   * request binding lands. The app mount keeps its publisher for the signed-in
   * context and wants it; the post-answer refresh awaits the binding itself and
   * redraws, and its publisher is thrown away, so it does not subscribe.
   */
  redrawOnAskBound?: boolean;
};

/**
 * The one wiring of the glanceable publisher: the registered sinks, the
 * persisted revision seed, the terminal-blank and lost-org fences, and the
 * waiting-ask record with the request it is bound to (see `ask-binding.ts`).
 * The app mount and the headless refresh both build their publisher here, so
 * neither can drift from the other's options.
 */
export function createGlanceablePublisher(
  options: CreateGlanceablePublisherOptions = {}
): GlanceablePublisher {
  return new GlanceablePublisher({
    sinks: getGlanceableSinks(),
    initial: getLastGlanceableSnapshot(),
    terminalBlankEpoch: getTerminalBlankEpoch,
    orgLost: isGlanceableOrgLost,
    onWaitingAskChange: recordSelectedAsk,
    subscribeAskBound: options.redrawOnAskBound === false ? undefined : subscribeAskBound,
    skipWaitingAskSessionId: options.skipWaitingAskSessionId,
  });
}
