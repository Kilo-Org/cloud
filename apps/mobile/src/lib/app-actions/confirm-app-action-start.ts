// The confirmation an externally requested `StartAgent` has to pass before the
// app creates a session.
//
// The native entry points (Siri, Shortcuts, the Action button, Control Center,
// a widget button, an action URL) reach the dispatcher without any screen, so
// the person never sees the request. This is the one surface that shows it:
// the prompt the request carries and the repository it targets, with a cancel
// answer that stops the run.

import { Alert } from 'react-native';

import { i18n } from '@/i18n';

/** Longest prompt text the confirmation shows; the run itself uses it whole. */
const PROMPT_DISPLAY_LIMIT = 240;

/** The fields of a `StartAgent` input the confirmation displays. */
export type StartConfirmationInput = {
  prompt: string;
  repository?: string;
};

/** The prompt as one line, shortened for display only. */
function displayPrompt(prompt: string): string {
  const single = prompt.replaceAll(/\s+/g, ' ').trim();
  if (single.length <= PROMPT_DISPLAY_LIMIT) {
    return single;
  }
  return `${single.slice(0, PROMPT_DISPLAY_LIMIT).trimEnd()}…`;
}

/** The repository the confirmation names: the request's, or the fallback. */
function displayRepository(repository: string | undefined): string {
  const named = repository?.trim();
  if (named === undefined || named.length === 0) {
    return i18n.t('appActions.start.confirmMostRecentRepository');
  }
  return named;
}

/**
 * Ask the person to confirm a `StartAgent` request another surface sent.
 * Resolves true on Continue, false on Cancel, on dismissal, and on a back press.
 *
 * The dispatcher only calls `startAgent` after this resolves true, so a
 * confirmed run is the one the person agreed to.
 */
export function confirmAppActionStart(input: StartConfirmationInput): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  Alert.alert(
    i18n.t('appActions.start.confirmTitle'),
    i18n.t('appActions.start.confirmMessage', {
      prompt: displayPrompt(input.prompt),
      repository: displayRepository(input.repository),
    }),
    [
      {
        text: i18n.t('common.cancel'),
        style: 'cancel',
        onPress: () => {
          resolve(false);
        },
      },
      {
        text: i18n.t('common.continue'),
        onPress: () => {
          resolve(true);
        },
      },
    ],
    {
      cancelable: true,
      onDismiss: () => {
        resolve(false);
      },
    }
  );
  return promise;
}
