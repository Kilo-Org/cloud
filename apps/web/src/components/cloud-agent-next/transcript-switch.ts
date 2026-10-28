/**
 * `local`: a chat this client created and the live transcript does not show yet.
 * It is known to be empty, so the page shows it at once without a loading state.
 */
export type TranscriptPhase = 'live' | 'opening' | 'failed' | 'local';

export type ResolveTranscriptPhaseInput = {
  requestedSessionId: string | null;
  lastStartedSessionId: string | null;
  ownerSessionId: string | null;
  cachedSessionId: string | null;
  isLoading: boolean;
  hasMessages: boolean;
  terminalOpenFailure: boolean;
  /** Messages known locally for a chat created here; null for any other chat. */
  localMessageCount: number | null;
  /** The live transcript's first replay has not landed yet. */
  isReplayingLiveHistory: boolean;
  /** A cached page with this Cloud Agent session's settings exists. */
  hasKnownSettings: boolean;
};

export function resolveTranscriptPhase({
  requestedSessionId,
  lastStartedSessionId,
  ownerSessionId,
  cachedSessionId,
  isLoading,
  hasMessages,
  terminalOpenFailure,
  localMessageCount,
  isReplayingLiveHistory,
  hasKnownSettings,
}: ResolveTranscriptPhaseInput): TranscriptPhase {
  if (!requestedSessionId) return 'live';
  // Before the switch starts, a known chat shows its settled frame; the switch
  // then paints its cached page before the browser paints.
  if (hasKnownSettings && requestedSessionId !== lastStartedSessionId) return 'local';
  if (
    localMessageCount !== null &&
    !terminalOpenFailure &&
    (ownerSessionId !== requestedSessionId ||
      (!hasMessages && (isLoading || (localMessageCount > 0 && isReplayingLiveHistory))))
  ) {
    return 'local';
  }
  if (requestedSessionId !== lastStartedSessionId) return 'opening';
  if (ownerSessionId === requestedSessionId) {
    return isLoading && !hasMessages && !terminalOpenFailure ? 'opening' : 'live';
  }
  // The cached page is known to be this session's, so it shows even when empty.
  if (ownerSessionId === null && cachedSessionId === requestedSessionId) return 'live';
  if (ownerSessionId === null && !isLoading && terminalOpenFailure) return 'failed';
  return 'opening';
}

export function transcriptReadyForEffects(phase: TranscriptPhase): boolean {
  return phase === 'live';
}
