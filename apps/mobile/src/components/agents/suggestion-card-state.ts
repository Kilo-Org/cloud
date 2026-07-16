type ToolStatus = 'pending' | 'running' | 'completed' | 'error';
type ActiveSuggestionIdentity = { requestId: string; callId?: string } | null;

export function resolveSuggestionPresentation(
  status: ToolStatus,
  callId: string | undefined,
  suggestion: ActiveSuggestionIdentity
): 'interactive' | 'compact' {
  const pending = status === 'pending' || status === 'running';
  return pending && suggestion?.callId !== undefined && suggestion.callId === callId
    ? 'interactive'
    : 'compact';
}

export function createSuggestionActionLock(): {
  tryAcquire: () => boolean;
  release: () => void;
} {
  let held = false;
  return {
    tryAcquire: () => {
      if (held) {
        return false;
      }
      held = true;
      return true;
    },
    release: () => {
      held = false;
    },
  };
}

export function suggestionActionError(kind: 'accept' | 'dismiss'): string {
  return kind === 'accept'
    ? "Couldn't apply this suggestion. Try again."
    : "Couldn't dismiss this suggestion. Try again.";
}
