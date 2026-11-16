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
  return (
    outcome.kind === 'catalog-failed' ||
    outcome.kind === 'restart-skipped' ||
    outcome.kind === 'reload-failed'
  );
}

function reportFailedFollow(outcome: ApplyLanguageOutcome, language: SupportedLanguage): void {
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
  if (
    getLanguagePreference() !== 'device' ||
    hasLanguagePreferenceWriteInFlight() ||
    i18n.resolvedLanguage === language
  ) {
    return;
  }
  // Loaded here, not at module scope: the apply module imports the `expo`
  // runtime, which a JS context without Expo cannot load, and the root
  // provider tree mounts everywhere including those. The import runs only when
  // a real device-language change needs the apply.
  const { applyDeviceLanguage } = await import('@/i18n/apply-language');
  const outcome = await applyDeviceLanguage(language);
  if (isFollowFailure(outcome)) {
    reportFailedFollow(outcome, language);
  }
  // The apply result must not stand when the person picked a language while it
  // ran: the pick changed the i18n instance (a manual pick applies in place
  // before it persists) or overwrote the stored preference. When either landed,
  // the pick won and the device follow drops the outcome silently.
  if (getLanguagePreference() !== 'device') {
    return;
  }
}

/** The tail of the apply chain; requests queue behind it, never beside it. */
let queuedApply: Promise<void> = Promise.resolve();

/**
 * Follow a device locale change to `language`. Applies only while the stored
 * preference is `device` and the active language differs. Requests are chained
 * so two device changes never interleave `changeLanguage`; a request the queue
 * has superseded — the person picked a language, or an earlier apply already
 * landed on this one — applies nothing. Never throws and never toasts: a failed
 * follow is reported and keeps the current language.
 */
export function requestDeviceLanguageFollow(language: SupportedLanguage): void {
  if (
    getLanguagePreference() !== 'device' ||
    hasLanguagePreferenceWriteInFlight() ||
    i18n.resolvedLanguage === language
  ) {
    return;
  }

  const previous = queuedApply;
  queuedApply = (async () => {
    await previous;
    try {
      await followDeviceLanguage(language);
    } catch {
      // A failed step must not drop every later request from the chain.
    }
  })();
}
