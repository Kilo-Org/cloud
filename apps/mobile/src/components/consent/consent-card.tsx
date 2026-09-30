import { type Href, useRouter } from 'expo-router';
import { LineChart, MessageSquare, Shield, Smartphone, User } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentCardFooter } from '@/components/consent/consent-card-footer';
import { ConsentRow } from '@/components/consent/consent-row';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { PRIVACY_URL } from '@/lib/config';
import { acceptConsent, readConsent, revokeConsent, setOptionalConsent } from '@/lib/consent';
import { openExternalUrl } from '@/lib/external-link';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ConsentCardProps = {
  readonly mode?: ConsentMode;
};

export function ConsentCard({ mode = 'onboarding' }: ConsentCardProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { top } = useSafeAreaInsets();
  const { signOut, token } = useAuth();
  const { userId } = useCurrentUserId({ enabled: token != null });
  const { t } = useTranslation();
  const actions = getConsentActions(mode);
  const rootStyle = { paddingTop: top };
  const contentContainerStyle = {
    paddingTop: 24,
    paddingBottom: 24,
  };
  const [pendingAction, setPendingAction] = useState<'primary' | 'secondary' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Onboarding pre-selects optional telemetry. Review mode starts off and the
  // stored value loads over it, so a stored decline never flashes as on.
  const [optionalToggle, setOptionalToggle] = useState(mode === 'onboarding');
  // Review mode must not present a switch state before the stored value has
  // loaded: the pre-load OFF looked like a completed revoke in the b911 vr5
  // e3 evidence (e3-toggled-off.png showed the switch off while the realm was
  // still consented — no toggle had landed). Until loaded, the switch slot
  // holds a same-size placeholder, so the card never claims a choice the
  // user has not made and a tap cannot flip the wrong way. With no userId
  // there is nothing to load: the switch renders as before and its toggle
  // path shows the account error.
  const [storedValueLoaded, setStoredValueLoaded] = useState(mode !== 'review');
  const optionalControlPending = mode === 'review' && userId !== undefined && !storedValueLoaded;
  const [savingOptional, setSavingOptional] = useState(false);
  const loadedRef = useRef(false);
  const userToggledRef = useRef(false);

  // Load the stored optional value in review mode only.  The active flag
  // stops a late resolve from overwriting a value the user just toggled.
  useEffect(() => {
    if (mode !== 'review' || !userId || loadedRef.current) {
      return undefined;
    }
    let active = true;
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- async/await would allow the promise to settle after unmount.
    void readConsent(userId).then(
      // eslint-disable-next-line promise/always-return
      stored => {
        if (active) {
          if (!userToggledRef.current) {
            setOptionalToggle(stored.optional);
            loadedRef.current = true;
          }
          setStoredValueLoaded(true);
        }
      },
      () => {
        if (active) {
          // The error names the unreliability, so the switch may show its
          // default; the placeholder only covers the silent loading window.
          setStoredValueLoaded(true);
          setError(t('consent.couldNotLoadConsentSettings'));
        }
      }
    );
    return () => {
      active = false;
    };
  }, [mode, userId, t]);

  const handlePrimaryAction = async () => {
    if (mode === 'review') {
      router.back();
      return;
    }

    if (!userId) {
      setError(t('consent.couldNotLoadAccount'));
      return;
    }

    setError(null);
    setPendingAction('primary');
    try {
      await acceptConsent(userId, optionalToggle);
      router.replace('/(app)/(tabs)' as Href);
    } catch {
      setError(t('consent.couldNotSaveConsent'));
      setPendingAction(null);
    }
  };

  const runSecondaryAction = async () => {
    setError(null);
    setPendingAction('secondary');

    if (mode === 'review') {
      if (!userId) {
        setError(t('consent.couldNotLoadAccount'));
        setPendingAction(null);
        return;
      }

      try {
        await revokeConsent(userId);
      } catch {
        setError(t('consent.couldNotRevokeConsent'));
        setPendingAction(null);
        return;
      }
    }

    try {
      await signOut();
    } catch {
      setError(
        mode === 'review' ? t('consent.revokedSignOutFailed') : t('consent.couldNotSignOut')
      );
      setPendingAction(null);
    }
  };

  const handleSecondaryAction = () => {
    const message =
      mode === 'review' ? t('consent.revokeSignOutMessage') : t('consent.declineSignOutMessage');

    Alert.alert(actions.destructiveTitle, message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: actions.destructiveLabel,
        style: 'destructive',
        onPress: () => {
          void runSecondaryAction();
        },
      },
    ]);
  };

  const handleOpenPrivacy = async () => {
    const label = t('consent.privacyPolicy');
    const opened = await openExternalUrl(PRIVACY_URL, { label, retryOnError: true });
    // The toast fires in the app root, behind this native modal, so it never
    // becomes visible here (app-root-providers D2). The pinned footer's error
    // line carries the failure where the person can see it; tapping the link
    // again is the retry.
    setError(opened ? null : t('common.couldNotOpen', { label }));
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
            setError(t('consent.couldNotSaveChoice'));
            setSavingOptional(false);
          }
        );
      } else if (mode === 'review') {
        setOptionalToggle(!next);
        setError(t('consent.couldNotLoadAccount'));
      }
    },
    [mode, userId, t]
  );

  return (
    <View className="flex-1 bg-background" style={rootStyle}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-6">
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Shield size={20} color={colors.foreground} />
            </View>
            <Text className="text-base font-semibold text-foreground">{t('consent.kilo')}</Text>
          </View>

          <Text className="mt-6 text-2xl font-bold text-foreground">
            {t('consent.beforeWeGetStarted')}
          </Text>
          <Text className="mt-3 text-base text-muted-foreground">
            {t('consent.introDescription')}
          </Text>

          <Text className="mt-6 text-sm font-semibold text-foreground">
            {t('consent.required')}
          </Text>

          <View className="mt-3 gap-5">
            <ConsentRow
              icon={MessageSquare}
              title={t('consent.promptsTitle')}
              description={t('consent.promptsDescription')}
            />
            <ConsentRow
              icon={User}
              title={t('consent.accountTitle')}
              description={t('consent.accountDescription')}
            />
            <ConsentRow
              icon={Smartphone}
              title={t('consent.diagnosticsTitle')}
              description={t('consent.diagnosticsDescription')}
            />
          </View>

          <Text className="mt-6 text-sm font-semibold text-foreground">
            {t('consent.optional')}
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
            accessibilityLabel={t('consent.seeFullDetails')}
            className="mt-6 flex-row items-center gap-1 active:opacity-70"
          >
            <Text className="text-sm font-semibold text-primary">
              {t('consent.seeFullDetails')}
            </Text>
            <DirectionalChevronRight size={16} color={colors.primary} />
          </Pressable>
        </View>
      </ScrollView>

      <ConsentCardFooter
        mode={mode}
        error={error}
        pendingAction={pendingAction}
        onOpenPrivacy={() => {
          void handleOpenPrivacy();
        }}
        onPrimary={() => {
          void handlePrimaryAction();
        }}
        onSecondary={handleSecondaryAction}
      />
    </View>
  );
}
