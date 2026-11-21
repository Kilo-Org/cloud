import { useEffect, useRef, useState } from 'react';

import { reloadAppAsync } from 'expo';
import { useRouter } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { I18nManager } from 'react-native';

import { activateLanguage } from '@/i18n/activate-language';
import {
  clearDirectionAttemptAsync,
  readDirectionAttemptAsync,
  writeDirectionAttemptAsync,
} from '@/i18n/direction-attempt';
import { isRtlLanguage, syncRtl } from '@/i18n/rtl';
import { runLanguageStartupDirectionGuardedAsync } from '@/i18n/startup-direction-run';
import { type LanguageReturnTarget, readLanguageReturnTarget } from '@/i18n/return-target';
import { languageReturnNavigation } from '@/i18n/language-return-navigation';
import { getResolvedLanguage, useLanguagePreference } from '@/lib/hooks/use-language-preference';
import { registerNeedsInputCategories } from '@/lib/notification-actions';
import { renameAndroidNotificationChannels } from '@/lib/notifications';

/** What the hook hands back to the root layout. */
type LanguageStartupPreparation = {
  /** True when the cold-start RTL reload failed after syncRtl forced the native direction. */
  languageReloadFailed: boolean;
  /** Clears a shown reload-failure screen after the user chooses Continue. */
  dismissLanguageReloadFailure: () => void;
};

/**
 * Resolves the active language once the stored preference has loaded, then
 * prepares the direction and catalog before first paint. A direction change
 * forces RTL and reloads the app; a catalog failure falls back to English so
 * the splash still hides. Held in `isLoading` so the tree never paints
 * English and then swaps.
 *
 * Runs once per language-preference load: the effect lists only the load bit,
 * so a navigation-readiness flip after preparation cannot re-enter the
 * sequence. Navigation readiness belongs to the return-navigation step only,
 * which the separate deferred effect below owns — the immediate navigation
 * reads the latest readiness through a ref so a target stashed after the
 * readiness flip still navigates without waiting for that effect.
 */
export function useLanguageStartupPreparation(options: {
  /** Whether the root navigation container has finished mounting. */
  navigationReady: boolean;
  /** Marks startup language readiness so the loading gate can lift. */
  setLanguageReady: (ready: boolean) => void;
}): LanguageStartupPreparation {
  const { navigationReady, setLanguageReady } = options;
  const { hasLoaded: languageHasLoaded } = useLanguagePreference();
  const router = useRouter();

  // True when the cold-start RTL reload failed after syncRtl forced the native
  // direction; the app then shows a Retry/Continue screen instead of painting LTR.
  const [languageReloadFailed, setLanguageReloadFailed] = useState(false);

  // Reopen the screen the user was on before an RTL reload: the target rides
  // in a ref (the SecureStore read is one-shot), and the navigation runs only
  // after the root navigator's mount effects. The stash bumps a state epoch,
  // so the deferred effect re-runs after the target lands — the effect cannot
  // observe a bare ref.
  const languageReturnTargetRef = useRef<LanguageReturnTarget | null>(null);
  const [languageReturnEpoch, setLanguageReturnEpoch] = useState(0);
  const routerRef = useRef(router);
  routerRef.current = router;
  const runLanguageReturnNavigationRef = useRef<(() => void) | null>(null);
  runLanguageReturnNavigationRef.current = () => {
    const target = languageReturnTargetRef.current;
    if (target === null) {
      return;
    }
    languageReturnTargetRef.current = null;
    const navigation = languageReturnNavigation(target);
    // One navigation per target: `withAnchor` rebuilds the navigators between
    // the shell and the reopened screen from the relaunch's empty state.
    if (navigation.method === 'navigate') {
      routerRef.current.navigate(navigation.href, { withAnchor: navigation.withAnchor });
    } else {
      routerRef.current.replace(navigation.href);
    }
  };
  const runLanguageReturnNavigation = () => {
    const run = runLanguageReturnNavigationRef.current;
    if (run) {
      run();
    }
  };
  // Latest readiness without putting it in the preparation effect's
  // dependencies: readiness is independent of the preference load, and a flip
  // after preparation must not run the sequence again.
  const navigationReadyRef = useRef(navigationReady);
  navigationReadyRef.current = navigationReady;

  useEffect(() => {
    if (!languageHasLoaded) {
      return undefined;
    }
    let cancelled = false;

    const prepareLanguage = async () => {
      const resolved = getResolvedLanguage();
      // Guarded: the direction step's effects are native calls, and a thrown
      // one must not skip the ready gate below, or the app stays behind this
      // layout's loading surface with nothing to recover from. A rejection is
      // reported once and then takes the same terminal path as a direction the
      // platform refused (`retry` -> the Retry/Continue screen).
      const direction = await runLanguageStartupDirectionGuardedAsync(
        {
          language: resolved,
          isRtl: I18nManager.isRTL,
          shouldBeRtl: isRtlLanguage(resolved),
        },
        {
          syncRtl,
          readAttempt: readDirectionAttemptAsync,
          writeAttempt: writeDirectionAttemptAsync,
          clearAttempt: clearDirectionAttemptAsync,
          reload: reloadAppAsync,
        },
        error => {
          Sentry.captureException(error, {
            tags: { 'error.subsystem': 'startup', 'error.operation': 'language_direction' },
          });
        }
      );
      if (direction === 'reloaded') {
        // The native reload tears down this JS context; nothing below runs.
        return;
      }
      // A direction that could not be applied still loads the language, then
      // shows the Retry/Continue screen instead of first-painting in the wrong
      // direction.
      const reloadFailed = direction === 'retry';
      // Reopen the screen the user was on before an RTL reload. Read once,
      // after the reload path, so the helper's one-shot delete is the only read.
      // On a failed reload the key stays in SecureStore, so Retry's successful
      // reloadAppAsync() still reopens the right screen on the relaunch.
      // The target rides in a ref: the read is one-shot, so the navigation
      // cannot re-read it — the deferred effect below navigates once the root
      // navigator's mount effects have run (navigationReady).
      let returnTarget: LanguageReturnTarget | null = null;
      if (!reloadFailed) {
        try {
          returnTarget = await readLanguageReturnTarget();
        } catch {
          // Failed read: fall through so the splash still hides.
        }
      }
      if (returnTarget !== null) {
        languageReturnTargetRef.current = returnTarget;
        setLanguageReturnEpoch(epoch => epoch + 1);
        if (navigationReadyRef.current) {
          runLanguageReturnNavigation();
        }
      }
      // Applies the language in place: `activateLanguage` warms the
      // plural-rules polyfill before the change (so the first render in the new
      // language already has its formatters), and the returned outcome is the
      // store, not the promise — a catalog the lazy backend failed to read is
      // recovered once inside it. Only an unrecoverable failure falls back to
      // English, and it is reported: `changeLanguage` never rejects, so without
      // this report a failed catalog would mean a silently English process.
      const activation = await activateLanguage(resolved);
      if (activation === 'failed') {
        await activateLanguage('en');
        Sentry.captureException(new Error(`Language catalog failed: ${resolved}`), {
          tags: { 'error.subsystem': 'startup', 'error.operation': 'language_catalog' },
        });
      }
      void renameAndroidNotificationChannels();
      // The module-scope category registration ran under the English default
      // while the stored preference was still loading; re-register the
      // Approve / Reply / Open PR / Open session buttons in the applied
      // language (same localization pass as the channel rename above).
      void registerNeedsInputCategories();
      if (!cancelled) {
        if (reloadFailed) {
          setLanguageReloadFailed(true);
        }
        setLanguageReady(true);
      }
    };

    void prepareLanguage();
    return () => {
      cancelled = true;
    };
    // Runs once per language-preference load: `languageHasLoaded` never resets,
    // and `setLanguageReady` is a stable setter. Readiness is deliberately
    // absent — the deferred effect below owns the readiness-driven navigation.
  }, [languageHasLoaded, setLanguageReady]);

  // Deferred half of the language return: fires when the navigator finishes
  // mounting after prepareLanguage stashed the target (the epoch bump makes
  // this effect re-run after the stash, so a stash landing after the ready
  // flip is still consumed).
  useEffect(() => {
    if (!navigationReady || languageReturnTargetRef.current === null) {
      return;
    }
    runLanguageReturnNavigation();
  }, [navigationReady, languageReturnEpoch, router]);

  return {
    languageReloadFailed,
    dismissLanguageReloadFailure: () => {
      setLanguageReloadFailed(false);
    },
  };
}
