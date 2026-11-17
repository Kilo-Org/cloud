import * as Sentry from '@sentry/react-native';

import { i18n } from '@/i18n';
import { type ApplyLanguageOutcome } from '@/i18n/apply-language';
import { type SupportedLanguage } from '@/i18n/languages';
import {
  getLanguagePreference,
  hasLanguagePreferenceWriteInFlight,
} from '@/lib/hooks/use-language-preference';

/** The outcomes a follow cannot recover from; the current language stays. */
function isFollowFailure(outcome: ApplyLanguageOutcome): boolean {
  // `restart-guarded` is the loop guard working (the running app already
  // recorded a relaunch for this language), not a failure.
  return (
    outcome.kind === 'catalog-failed' ||
    outcome.kind === 'restart-skipped' ||
    outcome.kind === 'reload-failed'
  );
}

/** True once a manual pick owns the language, or its preference write is in flight. */
function pickSupersedesFollow(): boolean {
  return getLanguagePreference() !== 'device' || hasLanguagePreferenceWriteInFlight();
}

function reportFailedFollow(outcome: ApplyLanguageOutcome, language: string): void {
  Sentry.captureException(
    new Error(`Device language follow failed for ${language}: ${outcome.kind}`),
    { tags: { 'error.subsystem': 'startup', 'error.operation': 'language_follow' } }
  );
}

async function followDeviceLanguage(language: SupportedLanguage): Promise<void> {
  // Re-read the admission once the queue reaches this request: a manual pick or
  // an earlier apply may have landed while it waited. A manual in-place pick
  // changes the i18n instance before its preference write lands, so the stored
  // value can still read `device` while the running language is already the
  // pick: the pending-write check closes that window, at dequeue (below) and
  // before the queue records the request.
  if (pickSupersedesFollow() || i18n.resolvedLanguage === language) {
    return;
  }
  // Loaded here, not at module scope: the apply module imports the `expo`
  // runtime, which a JS context without Expo cannot load, and the root
  // provider tree mounts everywhere including those. The import runs only when
  // a real device-language change needs the apply.
  const { applyDeviceLanguage, restorePickedLanguage } = await import('@/i18n/apply-language');
  const outcome = await applyDeviceLanguage(language);
  if (pickSupersedesFollow()) {
    // The apply already switched the catalog, so dropping its outcome alone
    // would leave the device language active while the stored preference names
    // the pick. Put the pick back.
    const restored = await restorePickedLanguage();
    if (restored !== null && isFollowFailure(restored)) {
      reportFailedFollow(restored, getLanguagePreference());
    }
    return;
  }
  if (isFollowFailure(outcome)) {
    reportFailedFollow(outcome, language);
  }
}

/** The tail of the apply chain; requests queue behind it, never beside it. */
let queuedApply: Promise<void> = Promise.resolve();

/**
 * Follow a device locale change to `language`. Applies only while the stored
 * preference is `device` and the active language differs. Requests are chained
 * so two device changes never interleave `changeLanguage`; a request the queue
 * has superseded — the person picked a language, or an earlier apply already
 * landed on this one — applies nothing, and a follow superseded while its apply
 * ran restores the pick it lost to. Never throws and never toasts: a failed
 * follow is reported and keeps the current language.
 */
export function requestDeviceLanguageFollow(language: SupportedLanguage): void {
  if (pickSupersedesFollow() || i18n.resolvedLanguage === language) {
    return;
  }

  const previous = queuedApply;
  queuedApply = (async () => {
    await previous;
    try {
      await followDeviceLanguage(language);
    } catch (error) {
      // A rejection that never reached an outcome — e.g. the dynamic import of
      // the apply module failing — still did not apply anything, so it is the
      // follow's failure to report, not one the queue can recover from.
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'startup', 'error.operation': 'language_follow' },
      });
    }
  })();
}
