import { type Href, useRouter } from 'expo-router';
import { LineChart, Shield } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentRequiredRows } from '@/components/consent/consent-required-rows';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { ConsentPolicySentence } from '@/components/consent/consent-policy-sentence';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { useAuth } from '@/lib/auth/auth-context';
import { acceptConsent, readConsent, revokeConsent, setOptionalConsent } from '@/lib/consent';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useSideInsetStyle } from '@/lib/screen-insets';

type ConsentCardProps = {
  readonly mode?: ConsentMode;
};

/**
 * Maximum font scale honoured by the pinned privacy disclosure.
 *
 * The disclosure sits in the card's pinned footer with the reserved error
 * line and two `size="lg"` buttons. Uncapped, the `text-sm` sentence grows
 * with Dynamic Type to several lines at the largest system text size, and
 * that height comes out of the sheet, not the scroll region: the footer has
 * no room left and the second action clips at the sheet bottom.
 *
 * 1.4 is the cap that keeps the sentence within two bounded lines on the
 * smallest supported width (360dp; the card's `px-6` leaves 318dp for the
 * row) now that the copy is `text-sm`. The sentence's longer segment — the
 * pt-BR lead-in — measures 209.52dp at scale 1 and the link 169.52dp, so at
 * 1.4 the lead-in is 293.3dp and each segment still takes its own line. It
 * also keeps the largest rendered sentence the size it already was: the old
 * `text-xs` copy at the previous 1.6 cap rendered 16.8dp, and 12.25dp at 1.4
 * renders 17.15dp. Scales below the cap pass through untouched, so a11y
 * users keep most of their preferred scale. Same reasoning as the tour
 * header's cap (see `tour-font-scale`).
 */
export const CONSENT_DISCLOSURE_MAX_FONT_SCALE = 1.4;

/**
 * The bound on the stored-consent read before the card gives up on it.
 *
 * The read is a keychain call, not a network request, so it has no deadline of
 * its own; without one a stalled read held the primary action disabled for as
 * long as the stall, with no visible reason (the explorer's dead-button
 * report). The value matches the app's control-plane request budget
 * (`CONTROL_PLANE_DEADLINE_MS`), so a read slower than a request that failed on
 * the same budget is treated as a failure, not as a longer wait.
 */
const STORED_LOAD_TIMEOUT_MS = 15_000;

export function ConsentCard({ mode = 'onboarding' }: ConsentCardProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom, top } = useSafeAreaInsets();
  const sideInsetStyle = useSideInsetStyle();
  const { signOut, token } = useAuth();
  const { userId } = useCurrentUserId({ enabled: token != null });
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const actions = getConsentActions(mode);
  const rootStyle = { paddingTop: top, ...sideInsetStyle };
  const contentContainerStyle = {
    paddingTop: 24,
    paddingBottom: 24,
  };
  // The action buttons sit in a pinned footer below the ScrollView, not in
  // the scroll content: the review modal is shorter than the card, and the
  // primary CTA was clipping off the sheet bottom (b911 vr1 spot check,
  // e2-pre-revoke.png / p1-declined-off.png). The footer keeps its own
  // layout space, so scrolling never moves the actions.
  const footerStyle = {
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };
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
  // e3 evidence (e3-toggled-off.png showed the switch off while the realm was
  // still consented — no toggle had landed), and onboarding needs the read
  // because an older consent record carries the choice it must start from.
  // Until loaded, the switch slot holds a same-size placeholder, so the card
  // never claims a choice the user has not made and a tap cannot flip the wrong
  // way. With no userId there is nothing to load: the switch renders as before
  // and its toggle path shows the account error.
  //
  // One union owns the whole load phase. `loading` is the state the finding
  // reported: with no bound the primary button sat disabled through it with no
  // visible difference from a settled card, so repeated taps read as a dead
  // button. Now the reserved footer status line names the wait, the read
  // itself is bounded (see STORED_LOAD_TIMEOUT_MS), and a timeout or a failed
  // read becomes `failed`, which renders the load error with its own Retry —
  // the card never shows a disabled-looking primary without a reason on
  // screen. `failed` never re-enables the primary: accepting would write the
  // default over a stored decision the read could not see.
  type StoredLoad =
    | { readonly status: 'idle' }
    | { readonly status: 'loading' }
    | { readonly status: 'ready' }
    | { readonly status: 'failed' };
  const [storedLoad, setStoredLoad] = useState<StoredLoad>({ status: 'idle' });
  const optionalControlPending = storedLoad.status === 'loading';
  const [savingOptional, setSavingOptional] = useState(false);
  const loadedRef = useRef(false);
  const userToggledRef = useRef(false);

  // Load the stored optional value. Review mode shows the accepted choice; a
  // record from an older consent version re-opens onboarding, and its choice is
  // what the switch must show, because an updated disclosure must never
  // re-enable analytics for someone who turned it off. With nothing to carry,
  // onboarding keeps its on-by-default. The active flag stops a late resolve
  // from overwriting a value the user just toggled.
  //
  // `retryKey` is the Retry affordance's own state: the failed card re-runs
  // the same read for the same account when the person asks for it. The bound
  // races the read against a timer; the loser's write is dropped, so only the
  // first settle of one attempt reaches the state.
  const [storedLoadRetryKey, setStoredLoadRetryKey] = useState(0);
  useEffect(() => {
    if (!userId) {
      // Nothing to load: the switch renders as before and its toggle path
      // shows the account error.
      setStoredLoad({ status: 'idle' });
      return undefined;
    }
    if (loadedRef.current) {
      // The stored value already settled for this account (the effect re-runs
      // on a mode change after a successful load). Stay `ready`: an `idle`
      // with a resolved account would disable the primary with no status
      // line and no Retry — a new silent dead state.
      setStoredLoad({ status: 'ready' });
      return undefined;
    }
    // One attempt owns the card at a time: the timeout's failed state and a
    // late read resolution race for the same card. The first settle — bound
    // or read, whichever lands first — takes ownership by clearing `active`,
    // so a read that settles after its own bound cannot flip the failed card
    // back to ready, and a settle after unmount or a Retry re-run publishes
    // nothing.
    let active = true;
    setStoredLoad({ status: 'loading' });
    const timeout = setTimeout(() => {
      if (active) {
        active = false;
        setStoredLoad({ status: 'failed' });
        setError('consent.couldNotLoadConsentSettings');
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
        // default; the placeholder only covers the loading window. The
        // primary stays disabled: an accept here would write the default over
        // a stored decision the read could not see.
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

    // Defense in depth beside the disabled state: with a resolved account, a
    // primary press before the stored read has answered must never write the
    // default over a stored decline. The failed state re-runs the read
    // through its Retry instead. Without an account there is nothing to
    // write; the error below names the problem.
    if (userId !== undefined && storedLoad.status !== 'ready') {
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

  const renderStoredLoadStatus = (): React.ReactNode => {
    if (storedLoad.status === 'loading') {
      return (
        <AccessibleStatus
          message={t('consent.loadingConsentSettings')}
          tone="status"
          className="text-sm"
        />
      );
    }
    if (storedLoad.status === 'failed') {
      return (
        <View className="flex-row items-center justify-center gap-1">
          {/* The load failure seeds `error` with the load key, but a later
              action on the failed card can write its own key (Decline's failed
              sign-out, a failed optional-save). The latest error wins: the
              load error is only the default this state starts from, and a
              hardcoded copy would hide the real failure. */}
          <AccessibleStatus
            message={t(error ?? 'consent.couldNotLoadConsentSettings')}
            className="text-sm"
          />
          <Pressable
            onPress={() => {
              setStoredLoadRetryKey(key => key + 1);
            }}
            hitSlop={LINE_ACTION_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            // The shared line-action box: its `-my-[7px]` keeps the row one
            // line tall, so a failed load grows the reserved slot by nothing
            // and the actions below it never move.
            className={`${LINE_ACTION_BOX_CLASS} flex-row items-center gap-1 px-1 active:opacity-70`}
          >
            <Text className="text-sm font-semibold text-primary">{t('common.retry')}</Text>
          </Pressable>
        </View>
      );
    }
    return <AccessibleStatus message={error ? t(error) : null} className="text-sm" />;
  };

  return (
    <View className="flex-1 bg-background" style={rootStyle}>
      {/* The body keeps the platform scroll indicator: at a compact window it
          is taller than the viewport, and the hidden thumb made the rest of it
          read as missing rather than as one scroll away. */}
      <ScrollView className="flex-1" contentContainerStyle={contentContainerStyle}>
        <View className="px-6">
          {/* The badge alone carries the brand: the title below already states
              what the screen is about, and repeating the product name beside
              the mark said nothing a reader did not already see. The mark keeps
              the name for assistive tech, which cannot read the glyph. */}
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('consent.kilo')}
            className="h-10 w-10 items-center justify-center rounded-lg bg-secondary"
          >
            <Shield size={20} color={colors.foreground} />
          </View>

          <Text className="mt-6 text-2xl font-bold text-foreground">
            {mode === 'review' ? t('consent.summaryTitle') : t('consent.beforeWeGetStarted')}
          </Text>
          <Text className="mt-3 text-base text-muted-foreground">
            {t('consent.introDescription')}
          </Text>

          <Text className="mt-6 text-sm font-semibold text-foreground">
            {t('consent.required')}
          </Text>

          <ConsentRequiredRows />

          <Text className="mt-6 text-sm font-semibold text-foreground">
            {mode === 'review' ? t('consent.optionalReview') : t('consent.optionalOnboarding')}
          </Text>

          <View className="mt-3 flex-row items-start gap-3 rounded-lg border border-border p-4">
            <View className="mt-0.5">
              <LineChart size={18} color={colors.mutedForeground} />
            </View>
            <View className="flex-1 shrink gap-1">
              <Text className="text-base font-semibold text-foreground">
                {t('consent.helpImprove')}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('consent.helpImproveDescription')}
              </Text>
            </View>
            {optionalControlPending ? (
              // Same footprint as the iOS Switch (51x31), so the real control
              // swaps in without moving the row.
              <Skeleton className="h-[31px] w-[51px] shrink-0 rounded-full" />
            ) : (
              <Switch
                value={optionalToggle}
                disabled={mode === 'review' && savingOptional}
                accessibilityLabel={t('consent.helpImprove')}
                onValueChange={handleToggleOptional}
              />
            )}
          </View>

          <Pressable
            onPress={() => {
              router.push(
                mode === 'review'
                  ? ('/(app)/consent-details?mode=review' as Href)
                  : ('/(app)/consent-details' as Href)
              );
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('consent.seeFullDetails')}
            // The row's own node carries the control-size floor: the link's
            // text line is 17.5dp, below the audit's 28dp minimum, and the
            // 8dp slop carries the 44pt region on top of it.
            className="mt-6 min-h-[28px] flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-semibold text-primary">
              {t('consent.seeFullDetails')}
            </Text>
            <DirectionalChevronRight size={16} color={colors.primary} />
          </Pressable>
        </View>
      </ScrollView>

      <View className="gap-3 bg-background px-6 pt-3" style={footerStyle}>
        {/* The error lives in the pinned footer, not the scroll content: the
            footer draws over the scroll tail, so a content-placed error was
            invisible behind the buttons (b911 vr2 device repro — staging
            error measured at y=792 under the Back/Revoke footer). The
            one-line slot is always reserved, so an error appears without
            moving the actions. The privacy disclosure is pinned here too,
            because at the foot of the scrolling body the footer edge cut the
            sentence in half. Its font scale is capped so the pinned height
            stays bounded (see CONSENT_DISCLOSURE_MAX_FONT_SCALE). The policy
            link's 28dp box overflows its 17.5dp line by 5.25dp, which stays
            inside this footer's `pt-3` top padding rather than reaching the
            scroll region above it. */}
        <ConsentPolicySentence
          prefix={t('consent.privacyPolicyPrefix')}
          linkLabel={t('consent.privacyPolicy')}
          maxFontSizeMultiplier={CONSENT_DISCLOSURE_MAX_FONT_SCALE}
          onOpenPolicy={handleOpenPrivacy}
        />
        <View className="min-h-5 justify-center">
          {/* The reserved slot carries the load phase the finding reported:
              while the stored read is in flight the line names the wait, so a
              disabled-looking primary has its reason on screen instead of
              reading as a dead control; when the read fails or times out the
              line becomes the load error with its own Retry, because the
              primary must stay disabled until the read answers. */}
          {renderStoredLoadStatus()}
        </View>
        <Button
          onPress={() => {
            void handlePrimaryAction();
          }}
          size="lg"
          accessibilityLabel={actions.primaryLabel}
          // Accepting before the stored (or carried) choice has loaded would
          // write the default over a decision the user already made, so the
          // primary answers only once the read is ready. A failed or timed-out
          // read keeps it disabled beside its Retry; in review mode the
          // primary is Back, which needs no stored choice and always works.
          disabled={
            // Onboarding with no resolved account keeps the primary operable:
            // there is nothing to load, and the guard reports the account
            // error (main's behaviour). Once an account exists, the stored
            // read must answer before an accept can write a choice over it —
            // a failed or timed-out read stays disabled beside its Retry. In
            // review mode the primary is Back, which needs no stored choice
            // and always works.
            (mode === 'onboarding' && userId !== undefined && storedLoad.status !== 'ready') ||
            pendingAction === 'secondary'
          }
          loading={pendingAction === 'primary'}
        >
          <Text>{actions.primaryLabel}</Text>
        </Button>
        <Button
          variant={mode === 'review' ? 'outline-destructive' : 'outline'}
          size="lg"
          onPress={handleSecondaryAction}
          accessibilityLabel={actions.secondaryLabel}
          disabled={pendingAction === 'primary'}
          loading={pendingAction === 'secondary'}
        >
          <Text>{actions.secondaryLabel}</Text>
        </Button>
      </View>
      {dialog}
    </View>
  );
}
