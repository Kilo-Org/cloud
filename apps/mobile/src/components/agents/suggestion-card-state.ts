import { i18n } from '@/i18n';

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

export function createSuggestionActionLock() {
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
    ? i18n.t('agentChat.suggestion.applyFailed')
    : i18n.t('agentChat.suggestion.dismissFailed');
}
