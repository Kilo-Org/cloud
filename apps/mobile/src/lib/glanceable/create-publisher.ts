import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { recordSelectedAsk, subscribeAskBound } from './ask-binding';
import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { getLastGlanceableSnapshot } from './persist';
import { GlanceablePublisher, type GlanceablePublisherContext } from './publisher';
import { getGlanceableSinks } from './sink-registry';

export type CreateGlanceablePublisherOptions = {
  /**
   * The signed-in context the publisher draws for. The persisted record is
   * adopted only when its scope key is this one.
   */
  context: GlanceablePublisherContext;
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
 * The restored record, split into what a publisher may adopt and the revision
 * it must not go below.
 *
 * A record is adopted only when its scope key is the one `context` derives,
 * the same fence `applyHomeWidgetResponse` and `replayVerifiedSnapshot` apply
 * to a remote snapshot. Any record still raises the revision floor: every sink
 * drops a frame at or below the revision it last applied, so the first frame of
 * this scope must outrank the one the surfaces already hold.
 */
function restoredSnapshotFor(context: GlanceablePublisherContext) {
  const restored = getLastGlanceableSnapshot();
  if (restored === null) {
    return { initial: null, initialRevision: 0 };
  }
  if (restored.scopeKey !== buildOpaqueScopeKey(context)) {
    return { initial: null, initialRevision: restored.revision };
  }
  return { initial: restored, initialRevision: restored.revision };
}

/**
 * The one wiring of the glanceable publisher: the registered sinks, the
 * persisted revision seed, the terminal-blank and lost-org fences, and the
 * waiting-ask record with the request it is bound to (see `ask-binding.ts`).
 * The app mount and the headless refresh both build their publisher here, so
 * neither can drift from the other's options.
 */
export function createGlanceablePublisher(
  options: CreateGlanceablePublisherOptions
): GlanceablePublisher {
  const { initial, initialRevision } = restoredSnapshotFor(options.context);
  return new GlanceablePublisher({
    sinks: getGlanceableSinks(),
    initial,
    initialRevision,
    terminalBlankEpoch: getTerminalBlankEpoch,
    orgLost: isGlanceableOrgLost,
    onWaitingAskChange: recordSelectedAsk,
    subscribeAskBound: options.redrawOnAskBound === false ? undefined : subscribeAskBound,
    skipWaitingAskSessionId: options.skipWaitingAskSessionId,
  });
}
