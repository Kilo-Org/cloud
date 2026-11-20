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
 *
 * `offline` and `failed` exist only when nothing is cached, because a disabled
 * (offline) or failed read produces no data of its own; a cached quote always
 * renders, whatever the read is doing.
 */
export type BriefingEstimateLineQuote =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'estimating' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unavailable'; readonly quote: UnavailableEstimate }
  | { readonly kind: 'quoted'; readonly quote: BriefingEstimate };

/** A resolved estimate the server will not honour (`canGenerate: false` at runtime). */
type UnavailableEstimate = Omit<BriefingEstimate, 'canGenerate'> & { readonly canGenerate: false };

/** The state of the estimate read the phase parser reads beside its data. */
type EstimateReadState = {
  /** Confirmed offline, so the query is disabled and will not start. */
  readonly offline: boolean;
  /** The read settled as an error. */
  readonly isError: boolean;
};

/**
 * The quote line's phase from the fields' validity and the estimate read.
 */
export function parseBriefingEstimateLineQuote(
  valid: boolean,
  read: EstimateReadState,
  estimate: BriefingEstimate | undefined
): BriefingEstimateLineQuote {
  if (!valid) {
    return { kind: 'invalid' };
  }
  // A cached quote outlives the read that produced it: going offline disables
  // the query but keeps its data, and a failed refetch keeps the last quote.
  // Data first, so the line never hides a quote the card still holds.
  if (estimate !== undefined) {
    if (estimate.canGenerate) {
      return { kind: 'quoted', quote: estimate };
    }
    // The wire type's `canGenerate` is a plain boolean, so TS cannot
    // discriminate on it alone: the runtime fact `canGenerate === false` here
    // is re-asserted into the phase's payload shape.
    return { kind: 'unavailable', quote: { ...estimate, canGenerate: false } };
  }
  // Nothing cached: a disabled read (offline) will not start, and a settled
  // failure has nothing to describe. Neither settles on its own, so neither may
  // claim the placeholder's wait.
  if (read.offline) {
    return { kind: 'offline' };
  }
  if (read.isError) {
    return { kind: 'failed' };
  }
  // No quote, not offline, no failure: the first read has not settled yet.
  return { kind: 'estimating' };
}

/**
 * Exactly one line per quote phase, so no flag pair can render two lines or the
 * wrong one. A cached quote renders whatever the read is doing: going offline
 * disables the query but keeps its data, and a failed refetch keeps the last
 * quote. `invalid` owns the line for unparsable fields, because the disabled
 * query cannot speak for the current limits. `offline` and `failed` render only
 * with no quote cached, each beside the recovery the card offers: connectivity
 * for the offline phase, and the card's Retry for the failed one.
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
    case 'offline': {
      // A disabled read will not start while the device is offline; the card's
      // other controls are disabled for the same reason, so the line says what
      // the whole card is waiting for instead of posing as a wait in progress.
      return <Text className="text-xs text-muted-foreground">{t('offline.noInternet')}</Text>;
    }
    case 'failed': {
      // The read settled as an error with no cached quote; the retry button
      // beside the line owns recovery, so the line only names the miss. The
      // copy names the estimate, not the briefs the card beside it lists.
      return (
        <Text className="text-xs text-muted-foreground">
          {t('agentBriefing.estimateLoadError')}
        </Text>
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
