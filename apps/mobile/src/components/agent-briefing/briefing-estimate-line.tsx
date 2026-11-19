import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { type BriefingEstimate } from '@kilocode/app-shared/agent-briefing';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { briefingEstimateUnavailableKey } from '@/lib/agent-briefing-state';
import { briefingMoney } from '@/lib/agent-briefing-format';

/**
 * The quote line's one phase per settled state of the estimate read. The
 * payload is the estimate wire type, so a screen passes its query's `data`
 * straight in; the phase narrows what each branch may read.
 */
export type BriefingEstimateLineQuote =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'estimating' }
  | { readonly kind: 'unavailable'; readonly quote: UnavailableEstimate }
  | { readonly kind: 'quoted'; readonly quote: BriefingEstimate };

/** A resolved estimate the server will not honour (`canGenerate: false` at runtime). */
type UnavailableEstimate = Omit<BriefingEstimate, 'canGenerate'> & { readonly canGenerate: false };

/**
 * The quote line's phase from the fields' validity and the estimate read.
 */
export function parseBriefingEstimateLineQuote(
  valid: boolean,
  estimate: BriefingEstimate | undefined
): BriefingEstimateLineQuote {
  if (!valid) {
    return { kind: 'invalid' };
  }
  if (estimate === undefined) {
    return { kind: 'estimating' };
  }
  if (estimate.canGenerate) {
    return { kind: 'quoted', quote: estimate };
  }
  // The wire type's `canGenerate` is a plain boolean, so TS cannot discriminate
  // on it alone: the runtime fact `canGenerate === false` here is re-asserted
  // into the phase's payload shape.
  return { kind: 'unavailable', quote: { ...estimate, canGenerate: false } };
}

/**
 * Exactly one line per quote phase, so no flag pair can render two lines or the
 * wrong one. An unparsable field disables the query, so the last estimate cannot
 * speak for the current limits and `invalid` owns the line. With no quote yet
 * the line is `estimating`: a paused (offline) or failed read has produced
 * nothing to describe, and the retry button beside it owns recovery, so
 * "cannot quote" copy never claims a quote that does not exist.
 */
export function BriefingEstimateLine({ quote }: { readonly quote: BriefingEstimateLineQuote }) {
  const { t, i18n } = useTranslation();
  switch (quote.kind) {
    case 'invalid': {
      return (
        <Text className="text-sm text-destructive">{t('agentBriefing.invalidSafeguards')}</Text>
      );
    }
    case 'estimating': {
      // The placeholder takes the estimate line's own height, so the card does
      // not grow or shrink when the quote lands. A skeleton is invisible to
      // assistive tech, so the polite live region beside it says what the
      // reserved line is waiting for.
      return (
        <View className="relative">
          <Skeleton className="h-4 w-40" />
          <Text accessibilityLiveRegion="polite" className="absolute size-px overflow-hidden">
            {t('common.loading')}
          </Text>
        </View>
      );
    }
    case 'unavailable': {
      return (
        <Text className="text-xs text-muted-foreground">
          {t(briefingEstimateUnavailableKey(quote.quote.unavailableReason))}
        </Text>
      );
    }
    case 'quoted': {
      return (
        <Text className="text-xs text-muted-foreground">
          {t('agentBriefing.estimate', {
            estimate: briefingMoney(quote.quote.estimatedCostMicrodollars, i18n.language),
            maximum: briefingMoney(quote.quote.maximumCostMicrodollars, i18n.language),
          })}
        </Text>
      );
    }
    default: {
      // Exhaustiveness: a new quote phase must be rendered above.
      const _exhaustive: never = quote;
      return _exhaustive;
    }
  }
}
