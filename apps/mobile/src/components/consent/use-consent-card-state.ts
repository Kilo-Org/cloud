import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { type ConsentLoadStatus } from '@/components/consent/consent-load-status';
import { useConfirmDialog } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth/auth-context';
import { acceptConsent, readConsent, revokeConsent, setOptionalConsent } from '@/lib/consent';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';

/** The bound on the stored-consent read before the card gives up on it. */
const STORED_LOAD_TIMEOUT_MS = 15_000;

/**
 * The consent card's behaviour: the stored-choice load, the primary and
 * secondary actions and the optional toggle.
 *
 * Extracted from the card so the load phase, whose states the finding about
 * the silent disabled primary named, can carry its own bounded read, retry
 * state and error keys without growing the card's render past the audit's
 * line budget. The card renders what this hook reports.
 *
 * The load union is `ConsentLoadStatus`. `loading` is the state the finding
 * reported: the primary sat disabled through it with no visible difference
 * from a settled card, so repeated taps read as a dead button. The reserved
 * footer status line names the wait, the read is bounded
 * (`STORED_LOAD_TIMEOUT_MS`), and a timeout or failed read becomes `failed`
 * with its own Retry. `failed` never re-enables the primary: accepting would
 * write the default over a stored decision the read could not see.
 */
export function useConsentCardState(mode: ConsentMode) {
  const router = useRouter();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const { signOut, token } = useAuth();
  const { userId } = useCurrentUserId({ enabled: token != null });
  const [pendingAction, setPendingAction] = useState<'primary' | 'secondary' | null>(null);
  // The catalogue key, not the copy: the card translates it at render, so the
  // line follows an applied language instead of keeping the words of the
  // language the action failed under.
  const [error, setError] = useState<string | null>(null);
  // Onboarding pre-selects optional telemetry; review mode starts off. The
  // stored value loads over either default, so a stored decline never flashes
  // as on.
  const [optionalToggle, setOptionalToggle] = useState(mode === 'onboarding');
  // The switch must not present a state before the stored value has loaded: in
  // review mode the pre-load OFF looked like a completed revoke in the b911 vr5
  // e3 evidence, and onboarding needs the read because an older consent record
  // carries the choice it must start from. With no userId there is nothing to
  // load: the switch renders as before and its toggle path shows the account
  // error.
  const [storedLoad, setStoredLoad] = useState<ConsentLoadStatus>({ status: 'idle' });
  const [savingOptional, setSavingOptional] = useState(false);
  const loadedRef = useRef(false);
  const userToggledRef = useRef(false);
  // The Retry affordance's own state: the failed card re-runs the same read
  // when the person asks for it. The first settle of one attempt — bound or
  // read — takes ownership and publishes; the loser's write is dropped.
  const [storedLoadRetryKey, setStoredLoadRetryKey] = useState(0);

  useEffect(() => {
    if (!userId) {
      // Nothing to load: the switch renders as before and its toggle path
      // shows the account error.
      setStoredLoad({ status: 'idle' });
      return undefined;
    }
    if (loadedRef.current) {
      // The stored value already settled (the effect re-runs on a mode
      // change). Stay `ready`: an `idle` with a resolved account would
      // disable the primary with no status line and no Retry.
      setStoredLoad({ status: 'ready' });
      return undefined;
    }
    // The first settle of one attempt — bound or read — clears `active` and
    // publishes; a read that settles after its own bound, after unmount, or
    // after a Retry re-run publishes nothing.
    let active = true;
    setStoredLoad({ status: 'loading' });
    const timeout = setTimeout(() => {
      if (active) {
        active = false;
        setStoredLoad({ status: 'failed' });
        // The bound publishes only while no newer failure owns the slot: a
        // Decline inside the window that failed its sign-out already wrote
        // the copy the person is reading, and overwriting it would hide the
        // newest failure behind the older attempt's default.
        setError(current => current ?? 'consent.couldNotLoadConsentSettings');
      }
    }, STORED_LOAD_TIMEOUT_MS);
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- async/await would allow the promise to settle after unmount.
    void readConsent(userId).then(
      // eslint-disable-next-line promise/always-return
      stored => {
        if (!active) {
          return;
        }
        active = false;
        clearTimeout(timeout);
        if (!userToggledRef.current) {
          setOptionalToggle(
            mode === 'review' ? stored.optional : (stored.previousOptional ?? true)
          );
          loadedRef.current = true;
        }
        setStoredLoad({ status: 'ready' });
        setError(null);
      },
      () => {
        if (!active) {
          return;
        }
        active = false;
        clearTimeout(timeout);
        // The error names the unreliability, so the switch may show its
        // default; the primary stays disabled: an accept here would write
        // the default over a stored decision the read could not see.
        setStoredLoad({ status: 'failed' });
        setError('consent.couldNotLoadConsentSettings');
      }
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [mode, userId, storedLoadRetryKey]);

  const handlePrimaryAction = async () => {
    if (mode === 'review') {
      router.back();
      return;
    }

    if (!userId) {
      setError('consent.couldNotLoadAccount');
      return;
    }

    // Defense in depth beside the disabled state: a primary press before the
    // stored read has answered must never write the default over a stored
    // decline. The failed state re-runs the read through its Retry instead.
    // (No account never reaches here: the branch above returns first.)
    if (storedLoad.status !== 'ready') {
      return;
    }

    setError(null);
    setPendingAction('primary');
    try {
      await acceptConsent(userId, optionalToggle);
      router.replace('/(app)/(tabs)' as Href);
    } catch {
      setError('consent.couldNotSaveConsent');
      setPendingAction(null);
    }
  };

  const runSecondaryAction = async () => {
    setError(null);
    setPendingAction('secondary');

    if (mode === 'review') {
      if (!userId) {
        setError('consent.couldNotLoadAccount');
        setPendingAction(null);
        return;
      }

      try {
        await revokeConsent(userId);
      } catch {
        setError('consent.couldNotRevokeConsent');
        setPendingAction(null);
        return;
      }
    }

    try {
      await signOut();
    } catch {
      setError(mode === 'review' ? 'consent.revokedSignOutFailed' : 'consent.couldNotSignOut');
      setPendingAction(null);
    }
  };

  const handleSecondaryAction = () => {
    const actions = getConsentActions(mode);
    const message =
      mode === 'review' ? t('consent.revokeSignOutMessage') : t('consent.declineSignOutMessage');

    confirm({
      title: actions.destructiveTitle,
      message,
      confirmLabel: actions.destructiveLabel,
      onConfirm: () => {
        void runSecondaryAction();
      },
    });
  };

  const handleOpenPrivacy = () => {
    router.push({ pathname: '/(app)/legal/[document]', params: { document: 'privacy' } });
  };

  const handleOpenDetails = () => {
    router.push(
      mode === 'review'
        ? ('/(app)/consent-details?mode=review' as Href)
        : ('/(app)/consent-details' as Href)
    );
  };

  const handleToggleOptional = useCallback(
    (next: boolean) => {
      setOptionalToggle(next);
      setError(null);

      if (mode === 'review' && userId) {
        userToggledRef.current = true;
        setSavingOptional(true);
        // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- fire-and-forget toggle revert pattern.
        void setOptionalConsent(userId, next).then(
          // eslint-disable-next-line promise/always-return
          () => {
            setSavingOptional(false);
          },
          () => {
            setOptionalToggle(!next);
            setError('consent.couldNotSaveChoice');
            setSavingOptional(false);
          }
        );
      } else if (mode === 'review') {
        setOptionalToggle(!next);
        setError('consent.couldNotLoadAccount');
      } else {
        // Onboarding: the switch is the user's own answer. The stored read can
        // still land later — the account id may resolve after this render — and
        // it must not overwrite a choice the user already made.
        userToggledRef.current = true;
      }
    },
    [mode, userId]
  );

  const primaryBlocked =
    // Onboarding with a resolved account needs the stored read's answer
    // before an accept can write a choice over it — a failed or timed-out
    // read stays disabled beside its Retry. With no resolved account the
    // primary stays operable and the guard reports the account error. In
    // review mode the primary is Back, which needs no stored choice.
    (mode === 'onboarding' && userId !== undefined && storedLoad.status !== 'ready') ||
    pendingAction === 'secondary';

  return {
    t,
    userId,
    pendingAction,
    error,
    optionalToggle,
    storedLoad,
    savingOptional,
    dialog,
    handlePrimaryAction,
    handleSecondaryAction,
    handleOpenPrivacy,
    handleOpenDetails,
    handleToggleOptional,
    retryStoredLoad: () => {
      setStoredLoadRetryKey(key => key + 1);
    },
    primaryBlocked,
  };
}
