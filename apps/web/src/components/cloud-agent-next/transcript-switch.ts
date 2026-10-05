export type TranscriptPhase = 'live' | 'opening' | 'failed';

export type ResolveTranscriptPhaseInput = {
  requestedSessionId: string | null;
  lastStartedSessionId: string | null;
  ownerSessionId: string | null;
  isLoading: boolean;
  hasMessages: boolean;
  terminalOpenFailure: boolean;
};

export function resolveTranscriptPhase({
  requestedSessionId,
  lastStartedSessionId,
  ownerSessionId,
  isLoading,
  hasMessages,
  terminalOpenFailure,
}: ResolveTranscriptPhaseInput): TranscriptPhase {
  if (!requestedSessionId) return 'live';
  if (requestedSessionId !== lastStartedSessionId) return 'opening';
  if (ownerSessionId === requestedSessionId) {
    return isLoading && !hasMessages && !terminalOpenFailure ? 'opening' : 'live';
  }
  if (ownerSessionId === null && !isLoading && terminalOpenFailure) return 'failed';
  return 'opening';
}

export function transcriptReadyForEffects(phase: TranscriptPhase): boolean {
  return phase === 'live';
}
