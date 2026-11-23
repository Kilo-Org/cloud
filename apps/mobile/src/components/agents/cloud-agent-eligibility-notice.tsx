import { type Href, useRouter } from 'expo-router';
import { Info } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AddCreditsRow } from '@/components/add-credits-row';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { type CloudAgentEligibilityState, isLimitedAccess } from '@/lib/cloud-agent-eligibility';
import { addCreditsDestinationFor, addCreditsProps } from '@/lib/credits/add-credits-destination';
import { formatPrefixedMoney } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { i18n } from '@/i18n';
import { cn } from '@/lib/utils';

const NOTICE_ICON_SIZE = 16;

type CloudAgentEligibilityNoticeProps = {
  state: CloudAgentEligibilityState;
  /** The account the form starts the session in; decides whose balance is topped up. */
  organizationId: string | undefined;
  /** Runs the eligibility read again, for the state where it failed. */
  onRetry: () => void;
  isRetrying: boolean;
  /** Spacing owned by the caller; the notice keeps its own geometry. */
  className?: string;
};

/**
 * The one block that states the Cloud Agent access a press would run into, in
 * the two states the server can answer: a balance that leaves the session on
 * free and BYOK models, and a read that failed so the composer claims nothing.
 *
 * The server stays the authority (`prepareSession` refuses what the balance
 * cannot pay for); this block only stops the phone offering it. It renders
 * nothing while the read is pending and nothing for an account with enough
 * balance, so the ordinary form is unchanged.
 *
 * The limited block is the info surface rather than the error one: free models
 * still work, so nothing is broken — the balance is simply not enough to spend
 * on the rest. It states the balance as the measured fact and the Add credits
 * control as the fix, and it does not restate the control's own label in a
 * sentence, which `apps/mobile/AGENTS.md` rules out.
 */
export function CloudAgentEligibilityNotice({
  state,
  organizationId,
  onRetry,
  isRetrying,
  className,
}: Readonly<CloudAgentEligibilityNoticeProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();

  if (state.kind === 'pending') {
    return null;
  }

  if (state.kind === 'failed') {
    // No tint: the read failed in the background and Start stays available, so
    // this is a line about a check that did not run, not a refusal.
    return (
      <View
        testID="cloud-agent-eligibility-notice"
        className={cn('flex-row items-center gap-2', className)}
      >
        <Text variant="muted" className="text-xs">
          {t('agentChat.newSession.eligibility.unavailable')}
        </Text>
        <Pressable
          onPress={onRetry}
          disabled={isRetrying}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          accessibilityState={{ disabled: isRetrying }}
          // The row is only as tall as its text, and React Native clips hit slop
          // to the parent's bounds, so the control carries the app's 48 dp floor
          // itself — the shape the analysis capacity notice uses.
          className={cn(
            STATE_ACTION_CLASS,
            'items-center justify-center px-2',
            'disabled:opacity-50'
          )}
        >
          <Text className="text-xs font-medium text-primary">{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  if (!isLimitedAccess(state)) {
    return null;
  }

  const balance = isolateLtrBidiText(formatPrefixedMoney(state.eligibility.balance, i18n.language));

  return (
    <View
      testID="cloud-agent-eligibility-notice"
      accessibilityRole="alert"
      className={cn(
        'gap-2 rounded-lg border border-info-tile-border bg-info-tile-bg px-3 py-2.5',
        className
      )}
    >
      <View className="flex-row items-center gap-2">
        <Info size={NOTICE_ICON_SIZE} color={colors.info} />
        <Text className="flex-1 text-sm font-semibold text-foreground">
          {t('agentChat.newSession.eligibility.limitedTitle')}
        </Text>
      </View>
      {/* The shared status channel states the balance as it arrives: the block
          appears after mount, so it must not be silent to a screen reader. */}
      <AccessibleStatus
        message={t('agentChat.newSession.eligibility.balance', { amount: balance })}
        tone="status"
        className="text-sm text-foreground"
      />
      {/* A limited balance still runs a free or BYOK model, so the fix is the
          top-up itself; the picker filters the list, so no sentence has to
          claim a restriction the picker already shows. */}
      <AddCreditsRow
        inline
        emphasis="primary"
        {...addCreditsProps(
          addCreditsDestinationFor(organizationId, () => {
            router.push('/(app)/credits' as Href);
          })
        )}
      />
    </View>
  );
}
