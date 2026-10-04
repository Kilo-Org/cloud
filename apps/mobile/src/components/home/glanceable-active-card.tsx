import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  countGlanceableSessions,
  glanceableStatusKind,
  type GlanceableStatusKind,
  soonestScheduledAt,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { namedSessionTitle } from '@/components/agents/session-detail-rename-state';
import { formatScheduledWake } from '@/components/agents/session-list-helpers';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { pickNewestSession } from '@/lib/glanceable/newest-session';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * The four ranked state counts, in the order every glanceable surface draws
 * them: what the user must act on, then what is making progress, then what will
 * wake later, then what is only connected. Zero rows still draw, so a session
 * changing state cannot reflow the card.
 */
const COUNT_LINES: readonly { kind: GlanceableStatusKind; labelKey: string }[] = [
  { kind: 'needsInput', labelKey: 'glanceable.needsInput' },
  { kind: 'running', labelKey: 'common.working' },
  { kind: 'scheduled', labelKey: 'common.scheduled' },
  { kind: 'idle', labelKey: 'common.idle' },
];

/**
 * One frame for the loaded card and its pending skeleton, so the placeholder
 * occupies the exact box the card will. Every row is a fixed height rather than
 * sized to its text, so a longer count label or a scheduled wake cannot move a
 * row: 4 heights of 6 + 3 gaps of 2 + 3 padding = 144, a 1px divider, then a
 * 68px newest block whose two 20px lines sit vertically centered.
 */
const CARD_CLASS = 'overflow-hidden rounded-2xl border border-border bg-card';
const COUNTS_CLASS = 'gap-2 px-4 py-3';
const COUNT_ROW_CLASS = 'h-6 flex-row items-center gap-2';
const DIVIDER_CLASS = 'h-px bg-border';
const NEWEST_BLOCK_CLASS = 'h-[68px] justify-center gap-1 px-4';
const NEWEST_ROW_CLASS = 'h-5 flex-row items-center gap-2';

function labelKeyFor(kind: GlanceableStatusKind): string {
  return COUNT_LINES.find(line => line.kind === kind)?.labelKey ?? 'common.working';
}

type GlanceableActiveCardProps = {
  sessions: readonly ActiveSession[];
  onPressSession: (session: ActiveSession) => void;
};

/**
 * The Home `Live now` card, composed from the native glanceable's vocabulary:
 * the four ranked state counts with the shared state dots, the soonest
 * scheduled wake beside its count, and the newest session with its state and
 * relative age. Tapping the newest session opens it; `See all` in the section
 * header opens the live index.
 */
export function GlanceableActiveCard({
  sessions,
  onPressSession,
}: Readonly<GlanceableActiveCardProps>) {
  const { t } = useTranslation();
  // A minute-bucketed clock keeps the relative age fresh without reading
  // `Date.now()` behind a memoized render (see `useNowTicker`).
  const now = useNowTicker(10_000);
  const counts = countGlanceableSessions(sessions);
  const primaryKind = COUNT_LINES.find(line => counts[line.kind] > 0)?.kind ?? null;
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
        {COUNT_LINES.map(line => {
          const isPrimary = line.kind === primaryKind;
          return (
            <View key={line.kind} className={COUNT_ROW_CLASS}>
              <SessionStatusIcon kind={line.kind} />
              <Text className="text-sm font-semibold text-foreground">{counts[line.kind]}</Text>
              <Text
                className={cn('text-sm', isPrimary ? 'text-foreground' : 'text-muted-foreground')}
                numberOfLines={1}
              >
                {t(line.labelKey)}
              </Text>
              {line.kind === 'scheduled' && scheduledWake !== null ? (
                <Text className="ml-auto text-xs text-muted-foreground">{scheduledWake}</Text>
              ) : null}
            </View>
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
        className="active:opacity-70"
      >
        <View className={NEWEST_BLOCK_CLASS}>
          {newestTitle !== null && newestKind !== null ? (
            <>
              <View className="h-5 justify-center">
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {newestTitle}
                </Text>
              </View>
              <View className={NEWEST_ROW_CLASS}>
                <SessionStatusIcon kind={newestKind} />
                <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
                  {stateLabel}
                </Text>
                {newestAge !== null ? (
                  <Text className="ml-auto text-xs text-muted-foreground">{newestAge}</Text>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/**
 * The pending placeholder. It repeats the card's exact frame and row heights so
 * the arriving card replaces it without moving the header, feedback or the
 * agent-create actions below.
 */
export function GlanceableActiveCardSkeleton() {
  return (
    <View
      className={CARD_CLASS}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className={COUNTS_CLASS}>
        {COUNT_LINES.map(line => (
          <View key={line.kind} className={COUNT_ROW_CLASS}>
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-6 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </View>
        ))}
      </View>
      <View className={DIVIDER_CLASS} />
      <View className={NEWEST_BLOCK_CLASS}>
        <View className="h-5 justify-center">
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
