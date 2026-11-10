import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  countGlanceableSessions,
  glanceableStatusKind,
  type GlanceableStatusKind,
  soonestScheduledAt,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  namedSessionTitle,
  useUserSessionTitlesRevision,
} from '@/components/agents/session-detail-rename-state';
import {
  STATUS_FILTER_ORDER,
  statusFilterLabelKey,
} from '@/components/agents/live-session-status-filter';
import { formatScheduledWake } from '@/components/agents/session-list-helpers';
import { EmptyState } from '@/components/empty-state';
import { CardControl } from '@/components/home/adaptive-home-card-frame';
import { DENSE_ROW_FRAME_CLASS, DENSE_ROW_HIT_SLOP } from '@/lib/a11y/tap-target';
import { Bot } from '@/components/ui/icons';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { pickNewestSession } from '@/lib/glanceable/newest-session';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

/** Shared minimum frame; text determines the loaded card's height. */
const CARD_CLASS = 'overflow-hidden rounded-2xl border border-border bg-card';
const COUNTS_CLASS = 'px-4 py-3';
const COUNT_ROW_CLASS = `${DENSE_ROW_FRAME_CLASS} flex-row items-center gap-2`;
const DIVIDER_CLASS = 'h-px bg-border';
const NEWEST_BLOCK_CLASS = 'min-h-[68px] justify-center gap-1 px-4 py-3';
const NEWEST_ROW_CLASS = 'min-h-5 flex-row items-center gap-2';

type GlanceableActiveCardProps = {
  sessions: readonly ActiveSession[];
  onPressSession: (session: ActiveSession) => void;
  /** Opens the live index narrowed to one state. Rows stay inert without it. */
  onPressStatus?: (kind: GlanceableStatusKind) => void;
  embedded?: boolean;
};

/**
 * The Home `Live now` card, composed from the native glanceable's vocabulary:
 * the four ranked state counts with the shared state dots, the soonest
 * scheduled wake beside its count, and the newest session with its state and
 * relative age. Tapping the newest session opens it; `See all` in the section
 * header opens the live index. With no sessions it is the zero state, and four
 * zero counts would only restate its one message: the counters are left out and
 * the empty message takes the card's body.
 */
export function GlanceableActiveCard({
  sessions,
  onPressSession,
  onPressStatus,
  embedded = false,
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
  const stateLabel = newestKind === null ? null : t(statusFilterLabelKey(newestKind));
  const newestAt = newest?.at ?? null;
  const newestAge = newestAt === null ? null : timeAgo(parseTimestamp(newestAt), undefined, now);
  const newestLabel = [newestTitle, stateLabel, newestAge].filter(Boolean).join(', ');
  const empty = newestSession === null;

  return (
    <View
      className={cn(
        CARD_CLASS,
        embedded && 'rounded-none border-0 bg-transparent',
        // The frame reserves the counts card's height, so the zero state fills
        // that height with its one message instead of leaving a band below it.
        empty && 'flex-1'
      )}
    >
      {empty ? null : (
        <>
          <View className={COUNTS_CLASS}>
            {STATUS_FILTER_ORDER.map(line => {
              const isPrimary = line.kind === primaryKind;
              // Counts read as one column, so the rows keep the dense row
              // rhythm; hitSlop lifts each touch target past 44 dp. Rows
              // render through CardControl so the reserved layer stays inert.
              return (
                <CardControl
                  key={line.kind}
                  onPress={
                    onPressStatus === undefined
                      ? undefined
                      : () => {
                          onPressStatus(line.kind);
                        }
                  }
                  accessibilityRole={onPressStatus === undefined ? undefined : 'button'}
                  testID={`home-status-${line.kind}`}
                  hitSlop={onPressStatus === undefined ? undefined : DENSE_ROW_HIT_SLOP}
                  className={COUNT_ROW_CLASS}
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
                      {t(line.labelKey)}
                    </Text>
                    {line.kind === 'scheduled' && scheduledWake !== null ? (
                      <Text className="max-w-full text-xs text-muted-foreground">
                        {scheduledWake}
                      </Text>
                    ) : null}
                  </View>
                </CardControl>
              );
            })}
          </View>
          <View className={DIVIDER_CLASS} />
        </>
      )}
      {/* Keyed by the newest session: the zero state has to be its own host
          view. React Native copies the previous props and applies only the keys
          it receives, so a label this component stops passing keeps its old
          value on the native view, and Android keeps announcing the previous
          account's session from the reused node. A new node per session and
          per zero state is the same remedy the PR-review inbox slot uses. */}
      {newestSession !== null && newestTitle !== null && newestKind !== null ? (
        <CardControl
          key={newestSession.id}
          onPress={() => {
            onPressSession(newestSession);
          }}
          accessibilityRole="button"
          accessibilityLabel={newestLabel}
        >
          <View className={NEWEST_BLOCK_CLASS}>
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
          </View>
        </CardControl>
      ) : (
        <View key="no-session" className="flex-1 justify-center">
          {/* The card keeps its reserved frame with nothing live, so the zero
              state fills that frame with the shared empty state's icon, title
              and one-line hint instead of a lone line in a blank card. */}
          <EmptyState
            placement="static"
            icon={Bot}
            title={t('home.noLiveSessions')}
            description={t('agents.sessionList.noSessionsYetDescription')}
          />
        </View>
      )}
    </View>
  );
}

/** The pending placeholder repeats the card's minimum frame and count rows. */
export function GlanceableActiveCardSkeleton({
  embedded = false,
}: { readonly embedded?: boolean } = {}) {
  return (
    <View
      className={cn(CARD_CLASS, embedded && 'rounded-none border-0 bg-transparent')}
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
