import { LineChart, Shield } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentRequiredRows } from '@/components/consent/consent-required-rows';
import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { ConsentPolicySentence } from '@/components/consent/consent-policy-sentence';
import {
  type ConsentLoadStatus,
  ConsentLoadStatusLine,
} from '@/components/consent/consent-load-status';
import { useConsentCardState } from '@/components/consent/use-consent-card-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowGroup } from '@/components/ui/row-group';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';

type ConsentCardProps = {
  readonly mode?: ConsentMode;
};

/**
 * Maximum font scale honoured by the pinned privacy disclosure.
 *
 * The disclosure sits in the card's pinned footer with the reserved status
 * line and two `size="lg"` buttons. Uncapped, the `text-sm` sentence grows
 * with Dynamic Type to several lines at the largest system text size, and
 * that height comes out of the sheet, not the scroll region: the footer has
 * no room left and the second action clips at the sheet bottom.
 *
 * 1.4 is the cap that keeps the sentence within two bounded lines on the
 * smallest supported width (360dp; the card's 14pt gutter leaves 332dp for
 * the row) now that the copy is `text-sm`. The sentence's longer segment — the
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
 * The data-sharing consent surface ("Before we get started" onboarding, and the
 * review screen an updated disclosure reopens). `useConsentCardState` owns the
 * behaviour; this component renders it.
 */
export function ConsentCard({ mode = 'onboarding' }: ConsentCardProps) {
  const colors = useThemeColors();
  const { top } = useSafeAreaInsets();
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
  // The review surface is a pushed screen, so its header clears the status
  // bar; onboarding has no header and keeps clearing it here. Both keep the
  // side insets around the body and the pinned footer.
  const bodyStyle = mode === 'review' ? sideInsetStyle : { paddingTop: top, ...sideInsetStyle };
  // The switch must not present a state before the stored value has loaded;
  // `optionalIsPending` owns the rule (its doc carries the reasoning and the
  // cases).
  const optionalControlPending = optionalIsPending(userId !== undefined, storedLoad);

  return (
    <View className="flex-1 bg-background">
      {mode === 'review' ? <ScreenHeader title={t('consent.summaryTitle')} /> : null}
      {/* The body keeps the platform scroll indicator: at a compact window it
          is taller than the viewport, and the hidden thumb made the rest of
          it read as missing rather than as one scroll away. */}
      <ScrollView
        className="flex-1"
        style={bodyStyle}
        contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-6')}
      >
        {/* The badge alone carries the brand: the title above already states
            what the screen is about, and repeating the product name beside
            the mark said nothing a reader did not already see. The mark keeps
            the name for assistive tech, which cannot read the glyph. */}
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('consent.kilo')}
          className="h-10 w-10 items-center justify-center rounded-lg border border-border"
        >
          <Shield size={20} color={colors.foreground} />
        </View>

        <View className="gap-1">
          {/* Review mode's title sits in the header above, so the body starts
              with the sentence that explains the summary. */}
          {mode === 'review' ? null : (
            <Text variant="large">{t('consent.beforeWeGetStarted')}</Text>
          )}
          <Text variant="muted">{t('consent.introDescription')}</Text>
        </View>

        <Section label={t('consent.required')}>
          <ConsentRequiredRows />
        </Section>

        <Section
          label={mode === 'review' ? t('consent.optionalReview') : t('consent.optionalOnboarding')}
        >
          <RowGroup leadingTile>
            {/* Until the stored choice loads the row shows no switch: a switch
                would present a value the user has not chosen and a tap could
                flip the wrong way, so the slot holds a control-sized
                placeholder in the same row shape instead. */}
            {optionalControlPending ? (
              <ConfigureRow
                icon={LineChart}
                title={t('consent.helpImprove')}
                subtitle={t('consent.helpImproveDescription')}
                trailing={<Skeleton className="h-8 w-14 rounded-full" />}
              />
            ) : (
              <PreferenceRow
                icon={LineChart}
                title={t('consent.helpImprove')}
                subtitle={t('consent.helpImproveDescription')}
                value={optionalToggle}
                disabled={mode === 'review' && savingOptional}
                onValueChange={handleToggleOptional}
              />
            )}
          </RowGroup>
        </Section>

        <Pressable
          onPress={() => {
            handleOpenDetails();
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('consent.seeFullDetails')}
          // The row's own node carries the control-size floor: the link's text
          // line is below the audit's 28dp minimum, and the 8dp slop carries the
          // 44pt region on top of `ROW_TARGET_CLASS`.
          className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-1 active:opacity-70')}
        >
          <Text variant="small" className="text-primary">
            {t('consent.seeFullDetails')}
          </Text>
          <RowChevron />
        </Pressable>
      </ScrollView>

      <ScreenFooter>
        <View className="gap-3">
          {/* The error lives in the pinned footer, not the scroll content: the
              footer draws over the scroll tail, so a content-placed error was
              invisible behind the buttons (b911 vr2 device repro — staging
              error measured at y=792 under the footer). The disclosure is
              pinned here too, because at the foot of the scrolling body the
              footer edge cut the sentence in half. Its font scale is capped so
              the pinned height stays bounded (see
              CONSENT_DISCLOSURE_MAX_FONT_SCALE), and it leads the block: the
              footer's own top padding is the same 12dp that `gap-3` keeps
              between the line and the primary button, so the disclosure reads
              as part of the actions it qualifies instead of floating between
              the divider and them. */}
          <ConsentPolicySentence
            prefix={t('consent.privacyPolicyPrefix')}
            linkLabel={t('consent.privacyPolicy')}
            maxFontSizeMultiplier={CONSENT_DISCLOSURE_MAX_FONT_SCALE}
            onOpenPolicy={handleOpenPrivacy}
          />
          {actions.primaryLabel ? (
            <Button
              onPress={() => {
                void handlePrimaryAction();
              }}
              size="lg"
              accessibilityLabel={actions.primaryLabel}
              // `primaryBlocked` is the rule that the primary exists only in
              // onboarding and needs the stored read's answer there; it sits on
              // the state hook beside the code it guards.
              disabled={primaryBlocked}
              loading={pendingAction === 'primary'}
            >
              <Text>{actions.primaryLabel}</Text>
            </Button>
          ) : null}
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
          {/* The reserved status slot renders below the actions: its reserve
              must not sit between the disclosure and the buttons it qualifies
              (an empty spacer with two gap edges sat between the disclosure
              and the Accept button, floating the line away from the block it
              qualifies). The slot keeps its one-line height whenever it is
              mounted (the same reserve as the credits expiry line and the
              guardrails and spend-alerts save status), in flow after the
              container's `gap-3`: the failed phase's Retry overflows its
              17.5dp line by 5.25dp on each side (`LINE_ACTION_BOX_CLASS`'s
              `-my-[7px]` on a 28dp box), and that overflow needs the container
              gap above the row and the footer's bottom padding below it to
              land inside the footer — a negative margin here would put the
              Retry's upper hit band under the secondary button's edge and its
              lower band past the footer's bottom. The band below the
              secondary button is the reserve; the footer's height changes by
              nothing across the default phases because the slot never unmounts. */}
          <View className="min-h-5 justify-center">
            <ConsentLoadStatusLine
              load={storedLoad}
              error={error}
              onRetry={retryStoredLoad}
              t={t}
            />
          </View>
        </View>
      </ScreenFooter>
      {dialog}
    </View>
  );
}
