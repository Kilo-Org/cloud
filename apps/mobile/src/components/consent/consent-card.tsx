import { LineChart, Shield } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentRequiredRows } from '@/components/consent/consent-required-rows';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { ConsentPolicySentence } from '@/components/consent/consent-policy-sentence';
import {
  type ConsentLoadStatus,
  ConsentLoadStatusLine,
} from '@/components/consent/consent-load-status';
import { useConsentCardState } from '@/components/consent/use-consent-card-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
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
 * Whether the optional switch holds the same-size placeholder.
 *
 * The placeholder covers every render with a resolved account and no stored
 * answer: `loading` is the read in flight, and `idle` is the render between
 * the account arriving and the load effect committing `loading` — one the
 * test renderer cannot observe, because its `act` flushes effects. Only
 * `ready` and `failed` have observed the stored record (or its refusal), so
 * only they may paint a choice. No account means nothing to load: the switch
 * renders as before and its toggle path reports the account error.
 */
export function optionalIsPending(hasAccount: boolean, load: ConsentLoadStatus): boolean {
  if (!hasAccount) {
    return false;
  }
  return load.status === 'loading' || load.status === 'idle';
}

/**
 * The data-sharing consent surface ("Before we get started" onboarding, and
 * the review sheet an updated disclosure reopens). `useConsentCardState`
 * owns the behaviour; this component renders it.
 */
export function ConsentCard({ mode = 'onboarding' }: ConsentCardProps) {
  const colors = useThemeColors();
  const { bottom, top } = useSafeAreaInsets();
  const sideInsetStyle = useSideInsetStyle();
  const { t } = useTranslation();
  const actions = getConsentActions(mode);
  const {
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
    retryStoredLoad,
    primaryBlocked,
  } = useConsentCardState(mode);
  const rootStyle = { paddingTop: top, ...sideInsetStyle };
  const contentContainerStyle = {
    paddingTop: 24,
    // The footer's top border marks the scroll edge, and this tail keeps the
    // last child ("See full details", the scroll content's final pressable)
    // clear of it when the list is scrolled to its end: without the extra
    // tail that row stops flush against the border and the scroll extent
    // reads as "one row short" instead of "one scroll away". The tail only
    // adds blank space after that final pressable, so it acts once the list
    // is scrolled to its end — at rest above the fold it changes nothing.
    paddingBottom: 40,
  };
  // The action buttons sit in a pinned footer below the ScrollView, not in
  // the scroll content: the review modal is shorter than the card, and the
  // primary CTA was clipping off the sheet bottom (b911 vr1 spot check,
  // e2-pre-revoke.png / p1-declined-off.png). The footer keeps its own
  // layout space, so scrolling never moves the actions.
  const footerStyle = {
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };
  // The switch must not present a state before the stored value has loaded;
  // `optionalIsPending` owns the rule (its doc carries the reasoning and the
  // cases).
  const optionalControlPending = optionalIsPending(userId !== undefined, storedLoad);
  // The status slot renders only when the reserved line has content: with no
  // line the `min-h-5` reserve plus its two gap edges would separate the
  // privacy disclosure from the actions by three gaps instead of one (see
  // the slot comment below the disclosure).
  const statusLineVisible =
    storedLoad.status === 'loading' ||
    storedLoad.status === 'failed' ||
    error !== null;

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
              handleOpenDetails();
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

      <View className="gap-3 border-t border-border bg-background px-6 pt-3" style={footerStyle}>
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
        {/* The slot's View must not mount while it has no line to show: a
            `min-h-5` View with a null child still occupies its reserve and
            its two gap edges, which measured 44dp between the privacy line
            and the Accept button and left the line floating between the
            divider and the actions. The reserved height only matters when a
            status renders, so the reserve stays on the mounted branch — an
            appearing status line keeps the actions still — and the unmounted
            branch collapses to a single 12dp gap on each side. */}
        {statusLineVisible ? (
          <View className="min-h-5 justify-center">
            <ConsentLoadStatusLine load={storedLoad} error={error} onRetry={retryStoredLoad} t={t} />
          </View>
        ) : null}
        <Button
          onPress={() => {
            void handlePrimaryAction();
          }}
          size="lg"
          accessibilityLabel={actions.primaryLabel}
          // `primaryBlocked`'s rule sits on the state hook beside the code it
          // guards.
          disabled={primaryBlocked}
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
