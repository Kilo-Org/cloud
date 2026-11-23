import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { type TFunction } from 'i18next';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  getOrgKiloPassUsageState,
  type OrgKiloPassUsageAllocation,
} from '@/components/organization/org-kilo-pass-usage-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Building2, CornerDownLeft } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatNumber, formatPrefixedMoney } from '@/lib/format';
import { useOrgKiloPassUsage } from '@/lib/hooks/use-organization-queries';
import { cn } from '@/lib/utils';

/** A money amount in the app's one shape, isolated so an RTL paragraph keeps its order. */
function money(microdollars: number, language: string): string {
  return isolateLtrBidiText(formatPrefixedMoney(fromMicrodollars(microdollars), language));
}

/** The bonus states that have already paid out, which fill their meter. */
function isBonusPaid(allocation: OrgKiloPassUsageAllocation): boolean {
  return allocation.bonusState === 'unlocked' || allocation.bonusState === 'upfront_granted';
}

/**
 * How much of the bonus's spend target a row has reached, from 0 to 100. A bonus
 * already paid reads full; a row with no target has nothing to measure.
 */
function bonusPercent(allocation: OrgKiloPassUsageAllocation): number {
  if (isBonusPaid(allocation)) {
    return 100;
  }
  const target = allocation.unlockTargetMicrodollars;
  if (target <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((allocation.qualifyingSpendMicrodollars / target) * 100));
}

/** The bonus line: a state sentence, or the progress toward the spend target. */
function bonusLine(allocation: OrgKiloPassUsageAllocation, t: TFunction, language: string): string {
  if (allocation.passCount === 0) {
    return t('organization.kiloPass.usage.noPasses');
  }
  switch (allocation.bonusState) {
    case 'locked': {
      return t('organization.kiloPass.usage.bonusLocked', {
        spent: money(allocation.qualifyingSpendMicrodollars, language),
        target: money(allocation.unlockTargetMicrodollars, language),
      });
    }
    case 'unlocked': {
      return t('organization.kiloPass.usage.bonusUnlocked');
    }
    case 'upfront_granted': {
      return t('organization.kiloPass.usage.bonusUpfront');
    }
    case 'expired': {
      return t('organization.kiloPass.usage.bonusExpired');
    }
    case 'missed': {
      return t('organization.kiloPass.usage.bonusMissed');
    }
    default: {
      const _exhaustive: never = allocation.bonusState;
      return _exhaustive;
    }
  }
}

/**
 * One allocated organization: the passes and monthly Credits it holds, the
 * bonus line with its amount, and the meter for the spend target. The meter
 * spans the row under both columns, so its track reads as the row's own.
 */
function AllocationRow({
  allocation,
  fullMonthlyCreditsPerPassUsd,
}: Readonly<{
  allocation: OrgKiloPassUsageAllocation;
  fullMonthlyCreditsPerPassUsd: number;
}>) {
  const { t, i18n } = useTranslation();
  const paid = isBonusPaid(allocation);
  const passLine = t('organization.kiloPass.usage.passLine', {
    count: allocation.passCount,
    passes: formatNumber(allocation.passCount, i18n.language),
    credits: money(allocation.baseCreditsMicrodollars, i18n.language),
  });
  return (
    <RowFrame
      // A child organization's pass is held by its parent, so the row carries
      // the corner mark the web table uses for the same relationship.
      icon={allocation.kind === 'child' ? CornerDownLeft : Building2}
      title={allocation.organizationName}
      subtitle={{ text: passLine }}
      footer={
        <View className="mt-2 gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Text variant="caption" className={cn(paid && 'text-good')}>
              {bonusLine(allocation, t, i18n.language)}
            </Text>
            <Text variant="caption">
              {money(allocation.bonusCreditsMicrodollars, i18n.language)}
            </Text>
          </View>
          <View className="h-1.5 rounded-full bg-muted-soft">
            <View
              className={cn('h-1.5 rounded-full', paid ? 'bg-good' : 'bg-primary')}
              style={{ width: `${bonusPercent(allocation)}%` }}
            />
          </View>
          {allocation.hasProratedCredits ? (
            <Text variant="caption">
              {t('organization.kiloPass.usage.proratedNote', {
                credits: isolateLtrBidiText(
                  formatPrefixedMoney(fullMonthlyCreditsPerPassUsd, i18n.language)
                ),
              })}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}

type OrgKiloPassUsageProps = Readonly<{
  organizationId: string;
  /** The billing role reaches the whole pass; every other role sees nothing. */
  hasBillingRole: boolean;
  /**
   * Whether the organization holds a Kilo Pass whose current period is still
   * running. The read alone cannot tell: it answers `null` for no agreement, for
   * an ended one, and for one that has issued no window yet.
   */
  agreementOpen: boolean;
}>;

/**
 * The organization's Kilo Pass usage: the Credits issued for the current window
 * and each allocated organization's bonus progress.
 *
 * The read shares the summary's gate (a billing role on the parent agreement
 * owner), so a child organization and a role without billing fire nothing and
 * paint nothing. Nothing here navigates or changes a plan: the pass assignments
 * live on the web billing page the screen already links.
 */
export function OrgKiloPassUsage({
  organizationId,
  hasBillingRole,
  agreementOpen,
}: OrgKiloPassUsageProps) {
  const { t } = useTranslation();
  const { data, isPending, isError, error, isFetching, refetch } = useOrgKiloPassUsage(
    organizationId,
    hasBillingRole && agreementOpen
  );
  const state = getOrgKiloPassUsageState({
    agreementOpen,
    hasBillingRole,
    isPending,
    isError,
    error,
    data,
  });

  const renderState = (): ReactNode => {
    switch (state.kind) {
      case 'hidden': {
        return null;
      }
      case 'loading': {
        // Three bars hold the loaded row's title, its pass line and its bonus
        // line, so the swap to real rows keeps the section's own rhythm. The
        // readout paints one row per allocated organization and only the answer
        // knows how many that is, so the placeholder reserves the one row every
        // answer starts with.
        return (
          <RowGroup leadingTile>
            <RowSkeleton tile subtitle lines={3} />
          </RowGroup>
        );
      }
      case 'empty': {
        return <Text variant="muted">{t('organization.kiloPass.usage.empty')}</Text>;
      }
      case 'unavailable': {
        return (
          <Text variant="muted" accessibilityRole="alert">
            {t('organization.kiloPass.usage.unavailable')}
          </Text>
        );
      }
      case 'retryable': {
        // The same contract as `BillingCardError` on this screen: the neutral
        // sentence and the retry that asks the read again.
        return (
          <Card>
            <Text variant="muted">{t('common.somethingWentWrong')}</Text>
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => void refetch()}
              loading={isFetching}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </Card>
        );
      }
      case 'ready': {
        return (
          <RowGroup leadingTile>
            {state.allocations.map(allocation => (
              <AllocationRow
                key={allocation.organizationId}
                allocation={allocation}
                fullMonthlyCreditsPerPassUsd={state.fullMonthlyCreditsPerPassUsd}
              />
            ))}
          </RowGroup>
        );
      }
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  };

  if (state.kind === 'hidden') {
    return null;
  }
  return <Section label={t('organization.kiloPass.usage.title')}>{renderState()}</Section>;
}
