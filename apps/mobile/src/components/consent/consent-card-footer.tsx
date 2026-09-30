import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type ConsentMode, getConsentActions } from '@/components/consent/consent-mode';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { INLINE_LINK_BOX_CLASS, inlineLinkHitSlop } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Maximum font scale honoured by the pinned privacy disclosure.
 *
 * The disclosure sits in the card's pinned footer with the reserved error
 * line and two `size="lg"` buttons. Uncapped, the `text-xs` sentence grows
 * with Dynamic Type to several lines at the largest system text size, and
 * that height comes out of the sheet, not the scroll region: the footer has
 * no room left and the second action clips at the sheet bottom. Capped at
 * 1.6 the sentence stays within two bounded lines on the smallest supported
 * width, so the footer keeps a bounded height and the actions stay on
 * screen; scales below 1.6 pass through untouched, so a11y users keep most
 * of their preferred scale. Same cap and reasoning as the tour header (see
 * `tour-font-scale`).
 */
export const CONSENT_DISCLOSURE_MAX_FONT_SCALE = 1.6;

type ConsentCardFooterProps = {
  readonly mode: ConsentMode;
  readonly error: string | null;
  readonly pendingAction: 'primary' | 'secondary' | null;
  readonly onPrimary: () => void;
  readonly onSecondary: () => void;
  readonly onOpenPrivacy: () => void;
};

/**
 * The consent card's pinned footer: privacy disclosure, the reserved error
 * line, and the two actions, all rendered below the ScrollView.
 */
export function ConsentCardFooter({
  mode,
  error,
  pendingAction,
  onPrimary,
  onSecondary,
  onOpenPrivacy,
}: ConsentCardFooterProps) {
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const actions = getConsentActions(mode);
  // The action buttons sit in a pinned footer below the ScrollView, not in
  // the scroll content: the review modal is shorter than the card, and the
  // primary CTA was clipping off the sheet bottom (b911 vr1 spot check,
  // e2-pre-revoke.png / p1-declined-off.png). The footer keeps its own
  // layout space, so scrolling never moves the actions.
  const footerStyle = {
    paddingBottom: Math.max(bottom, 16) + (Platform.OS === 'android' ? 8 : 0),
  };

  return (
    <View className="gap-3 bg-background px-6 pt-3" style={footerStyle}>
      {/* The error lives in the pinned footer, not the scroll content: the
          footer draws over the scroll tail, so a content-placed error was
          invisible behind the buttons (b911 vr2 device repro — staging
          error measured at y=792 under the Back/Revoke footer). The
          one-line slot is always reserved, so an error appears without
          moving the actions. The privacy disclosure is pinned here too,
          because at the foot of the scrolling body the footer edge cut the
          sentence in half. Its font scale is capped so the pinned height
          stays bounded (see CONSENT_DISCLOSURE_MAX_FONT_SCALE). */}
      {/* The link is a pressable with its own accessibility node, not a
          nested text span: a span shares the sentence's single native text
          node, so an accessibility tap (the E2E proof taps the link by
          label) lands on the sentence centre, misses the span, and never
          opens the policy. Its own node makes the whole link the target
          (idle-auth's inline links use the same pattern). */}
      <View className="flex-row flex-wrap items-center">
        <Text
          className="text-xs text-muted-foreground"
          maxFontSizeMultiplier={CONSENT_DISCLOSURE_MAX_FONT_SCALE}
        >
          {t('consent.privacyPolicyPrefix')}{' '}
        </Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('consent.privacyPolicy')}
          className={cn(INLINE_LINK_BOX_CLASS, 'active:opacity-70')}
          hitSlop={inlineLinkHitSlop('end')}
          onPress={onOpenPrivacy}
        >
          <Text
            className="text-xs text-primary underline"
            maxFontSizeMultiplier={CONSENT_DISCLOSURE_MAX_FONT_SCALE}
          >
            {t('consent.privacyPolicy')}
          </Text>
        </Pressable>
        <Text
          className="text-xs text-muted-foreground"
          maxFontSizeMultiplier={CONSENT_DISCLOSURE_MAX_FONT_SCALE}
        >
          .
        </Text>
      </View>
      <View className="min-h-5 justify-center">
        <AccessibleStatus message={error} className="text-sm" />
      </View>
      <Button
        onPress={onPrimary}
        size="lg"
        accessibilityLabel={actions.primaryLabel}
        disabled={pendingAction === 'secondary'}
        loading={pendingAction === 'primary'}
      >
        <Text>{actions.primaryLabel}</Text>
      </Button>
      <Button
        variant={mode === 'review' ? 'destructive' : 'outline'}
        size="lg"
        onPress={onSecondary}
        accessibilityLabel={actions.secondaryLabel}
        disabled={pendingAction === 'primary'}
        loading={pendingAction === 'secondary'}
      >
        <Text>{actions.secondaryLabel}</Text>
      </Button>
    </View>
  );
}
