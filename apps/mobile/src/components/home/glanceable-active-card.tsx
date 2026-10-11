import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  countGlanceableSessions,
  glanceableStatusKind,
  type GlanceableStatusKind,
  soonestScheduledAt,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  STATUS_FILTER_ORDER,
  statusFilterLabelKey,
} from '@/components/agents/live-session-status-filter';
import {
  namedSessionTitle,
  useUserSessionTitlesRevision,
} from '@/components/agents/session-detail-rename-state';
import { formatScheduledWake } from '@/components/agents/session-list-helpers';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { pickNewestSession } from '@/lib/glanceable/newest-session';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

/** Test id for the selectable row of one status kind. */
export function statusRowTestId(kind: GlanceableStatusKind): string {
  return `live-card-status-${kind}`;
}

/** Shared minimum frame; text determines the loaded card's height. */
const CARD_CLASS = 'overflow-hidden rounded-2xl border border-border bg-card';
const COUNTS_CLASS = 'gap-2 px-4 py-3';
const COUNT_ROW_CLASS = 'min-h-6 flex-row items-center gap-2';
const DIVIDER_CLASS = 'h-px bg-border';
const NEWEST_BLOCK_CLASS = 'min-h-[68px] justify-center gap-1 px-4 py-3';
const NEWEST_ROW_CLASS = 'min-h-5 flex-row items-center gap-2';

function labelKeyFor(kind: GlanceableStatusKind): string {
  return statusFilterLabelKey(kind);
}

type GlanceableActiveCardProps = {
  sessions: readonly ActiveSession[];
  onPressSession: (session: ActiveSession) => void;
  /**
   * Open the Agents list filtered to one status kind. Every count row calls
   * this, including a zero row, so the row is always a control and the user
   * gets the same empty-list explanation instead of a dead row.
   */
  onPressStatus: (kind: GlanceableStatusKind) => void;
};

/**
 * The Home `Live now` card, composed from the native glanceable's vocabulary:
 * the four ranked state counts with the shared state dots, the soonest
 * scheduled wake beside its count, and the newest session with its state and
 * relative age. Tapping a count row opens the Agents list filtered to that
 * status; tapping the newest session opens it; `See all` in the section header
 * opens the live index. With no sessions it is the zero state: every count
 * reads 0 and the newest block centers `Nothing running`.
 */
export function GlanceableActiveCard({
  sessions,
  onPressSession,
  onPressStatus,
}: Readonly<GlanceableActiveCardProps>) {
  const { t } = useTranslation();
  // A minute-bucketed clock keeps the relative age fresh without reading
  // `Date.now()` behind a memoized render (see `useNowTicker`).
  const now = useNowTicker(10_000);
  // `namedSessionTitle` reads the user-title store, which hydrates after a
  // cold start; subscribing re-renders the block once it lands.
  useUserSessionTitlesRevision();
  const counts = countGlanceableSessions(sessions);
  const primaryKind = STATUS_FILTER_ORDER.find(line => counts[line.kind] > 0)?.kind ?? null;
  const scheduledAt = soonestScheduledAt(sessions);
  const scheduledWake = scheduledAt === null ? null : formatScheduledWake(scheduledAt);
  // The widgets name the same session (`pickNewestSession`), and any live
  // session fills the block: an untitled one reads as the list rows'
  // untitled label, and a row with no time drops only the age.
  const newest = pickNewestSession(sessions);
  const newestSession = newest?.row ?? null;
  const newestKind = newestSession === null ? null : glanceableStatusKind(newestSession.status);
  const newestTitle =
    newestSession === null
      ? null
      : (namedSessionTitle(newestSession.title, newestSession.id) ??
        t('agents.sessionRow.untitled'));
  const stateLabel = newestKind === null ? null : t(labelKeyFor(newestKind));
  const newestAt = newest?.at ?? null;
  const newestAge = newestAt === null ? null : timeAgo(parseTimestamp(newestAt), undefined, now);
  const newestLabel = [newestTitle, stateLabel, newestAge].filter(Boolean).join(', ');

  return (
    <View className={CARD_CLASS}>
      <View className={COUNTS_CLASS}>
        {STATUS_FILTER_ORDER.map(line => {
          const isPrimary = line.kind === primaryKind;
          const label = t(line.labelKey);
          return (
            <Pressable
              key={line.kind}
              onPress={() => {
                onPressStatus(line.kind);
              }}
              accessibilityRole="button"
              testID={statusRowTestId(line.kind)}
              className={cn(COUNT_ROW_CLASS, 'active:opacity-70')}
            >
              <SessionStatusIcon kind={line.kind} />
              <Text className="text-sm font-semibold text-foreground">{counts[line.kind]}</Text>
              <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-1">
                <Text
                  className={cn(
                    'shrink text-sm',
                    isPrimary ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {label}
                </Text>
                {line.kind === 'scheduled' && scheduledWake !== null ? (
                  <Text className="max-w-full text-xs text-muted-foreground">{scheduledWake}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      <View className={DIVIDER_CLASS} />
      <Pressable
        disabled={newestSession === null}
        onPress={() => {
          if (newestSession !== null) {
            onPressSession(newestSession);
          }
        }}
        accessibilityRole={newestSession === null ? undefined : 'button'}
        accessibilityLabel={newestSession === null ? undefined : newestLabel}
        testID="live-card-newest"
        className="active:opacity-70"
      >
        <View className={cn(NEWEST_BLOCK_CLASS, newestSession === null && 'items-center')}>
          {newestTitle !== null && newestKind !== null ? (
            <>
              <Text className="text-sm text-foreground">{newestTitle}</Text>
              <View className={NEWEST_ROW_CLASS}>
                <SessionStatusIcon kind={newestKind} />
                <View className="min-w-0 flex-1 flex-row flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <Text className="max-w-full text-sm text-muted-foreground">{stateLabel}</Text>
                  {newestAge !== null ? (
                    <Text className="max-w-full text-xs text-muted-foreground">{newestAge}</Text>
                  ) : null}
                </View>
              </View>
            </>
          ) : (
            <Text className="text-sm text-muted-foreground">{t('home.noLiveSessions')}</Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}

/** The pending placeholder repeats the card's minimum frame and count rows. */
export function GlanceableActiveCardSkeleton() {
  return (
    <View
      className={CARD_CLASS}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className={COUNTS_CLASS}>
        {STATUS_FILTER_ORDER.map(line => (
          <View key={line.kind} className={COUNT_ROW_CLASS}>
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-6 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </View>
        ))}
      </View>
      <View className={DIVIDER_CLASS} />
      <View className={NEWEST_BLOCK_CLASS}>
        <View className="min-h-5 justify-center">
          <Skeleton className="h-3 w-2/3 rounded" />
        </View>
        <View className={NEWEST_ROW_CLASS}>
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-20 rounded" />
        </View>
      </View>
    </View>
  );
}
