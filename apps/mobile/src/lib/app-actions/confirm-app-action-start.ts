// The confirmation an externally requested `StartAgent` has to pass before the
// app creates a session.
//
// The native entry points (Siri, Shortcuts, the Action button, Control Center,
// a widget button, an action URL) reach the dispatcher without any screen, so
// the person never sees the request. This is the one surface that shows it:
// the prompt the request carries and the repository it targets, with a cancel
// answer that stops the run.

import { Alert, AppState, type AppStateStatus } from 'react-native';

import { i18n } from '@/i18n';

/** Longest repository text the confirmation shows; the run uses the whole value. */
const REPOSITORY_DISPLAY_LIMIT = 240;

/** How long a backgrounded request waits for the app to reach an activity. */
const ACTIVATION_TIMEOUT_MS = 10_000;

/**
 * Wait until the app is attached to an activity.
 *
 * A backgrounded app launches its main activity for the confirmation. React
 * Native drops an alert that runs before the activity attaches
 * ("Tried to show an alert while not attached to an Activity"), and the promise
 * would never settle, so the confirmation waits for the active state first.
 * False on the bound: the request is then refused rather than left hanging.
 */
function waitUntilActive(): Promise<boolean> {
  if (AppState.currentState === 'active') {
    return Promise.resolve(true);
  }
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (active: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    resolve(active);
  };
  const timer = setTimeout(() => {
    finish(false);
  }, ACTIVATION_TIMEOUT_MS);
  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      finish(true);
    }
  });
  const unsubscribe = (): void => {
    subscription.remove();
  };
  return promise;
}

/** The fields of a `StartAgent` input the confirmation displays. */
export type StartConfirmationInput = {
  prompt: string;
  repository?: string;
};

/**
 * The prompt as one line and whole: the confirmation shows exactly the text the
 * run sends, so the alert body scrolls rather than hiding a tail.
 */
function displayPrompt(prompt: string): string {
  return prompt.replaceAll(/\s+/g, ' ').trim();
}

/** A display-only bound for one line of text, with an ellipsis when cut. */
function boundForDisplay(value: string): string {
  if (value.length <= REPOSITORY_DISPLAY_LIMIT) {
    return value;
  }
  return `${value.slice(0, REPOSITORY_DISPLAY_LIMIT).trimEnd()}…`;
}

/** The repository the confirmation names: the request's, or the fallback. */
function displayRepository(repository: string | undefined): string {
  const named = repository?.trim();
  if (named === undefined || named.length === 0) {
    return i18n.t('appActions.start.confirmMostRecentRepository');
  }
  return boundForDisplay(named);
}

/**
 * Ask the person to confirm a `StartAgent` request another surface sent.
 * Resolves true on Continue, false on Cancel, on dismissal, and on a back press.
 *
 * A request that arrives while the app is backgrounded waits for the app to
 * reach an activity; an app that does not reach one inside the bound resolves
 * false, so the request is refused instead of left unanswered.
 *
 * The dispatcher only calls `startAgent` after this resolves true, so a
 * confirmed run is the one the person agreed to.
 */
export async function confirmAppActionStart(input: StartConfirmationInput): Promise<boolean> {
  if (!(await waitUntilActive())) {
    return false;
  }
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
