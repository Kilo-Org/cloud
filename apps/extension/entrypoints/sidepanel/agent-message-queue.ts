/*
 * One pending message per conversation. A send while a run is active appends to the
 * pending text after a blank line, so a second typed instruction is never dropped.
 */
export const appendQueuedMessage = (
  queued: string | undefined,
  text: string
): string | undefined => {
  const trimmed = text.trim();

  if (trimmed === '') {
    return queued;
  }

  return queued === undefined || queued === '' ? trimmed : `${queued}\n\n${trimmed}`;
};

/*
 * A run that was aborted (Stop, target tab loss, conversation close) drops its pending
 * message. Any other end sends it as the next turn.
 */
export const shouldSendQueuedMessage = ({
  aborted,
  queued,
}: {
  readonly aborted: boolean;
  readonly queued: string | undefined;
}): boolean => !aborted && queued !== undefined && queued.trim() !== '';

/*
 * What a composer submit does. Queue admission needs every precondition a normal send
 * needs; only the active run decides between queueing and sending.
 */
export const resolveSendAction = ({
  hasModel,
  hasTargetTab,
  isCompacting,
  isRunning,
  isStoreLoaded,
  text,
}: {
  readonly hasModel: boolean;
  readonly hasTargetTab: boolean;
  readonly isCompacting: boolean;
  readonly isRunning: boolean;
  readonly isStoreLoaded: boolean;
  readonly text: string;
}): 'ignore' | 'queue' | 'send' => {
  if (!isStoreLoaded || text.trim() === '' || isCompacting || !hasModel || !hasTargetTab) {
    return 'ignore';
  }

  return isRunning ? 'queue' : 'send';
};
