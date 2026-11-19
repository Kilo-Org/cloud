import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { Eyebrow } from '@/components/ui/eyebrow';
import { RowChevron } from '@/components/ui/row-chevron';
import { selectSessionRowEyebrowRight } from '@/components/ui/session-row-eyebrow-right';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Text } from '@/components/ui/text';
import { agentColor, isQuietTint, stateTint } from '@/lib/agent-color';
import { cn } from '@/lib/utils';

type SessionRowProps = {
  /** Uppercase label shown in the eyebrow, and hashed when no `agentState` is passed. */
  agentLabel: string;
  /**
   * The row tint to paint for the label: the word's colour must not drift with
   * its translation, so the key pins instead of hashing. `unknown` is a
   * placeholder for a value the row cannot name, `platform` names the kind of
   * agent the row ran on, and `repository` names the repository it ran in; all
   * three label the row's context rather than the session, so they take the
   * muted pair and the title leads. `idle` and `live` each pin a distinct
   * token — idle the quiet neutral strip, live the sky ramp entry (see
   * `stateTint`'s pin table). Omit it for a label that is the session's own
   * name, such as a chat's model, which hashes.
   */
  agentState?: 'unknown' | 'platform' | 'repository' | 'idle' | 'live' | null;
  title: string;
  /** Small line shown below the title (e.g. git branch, a message preview). */
  subtitle?: string | null;
  /**
   * Type style for the subtitle. `mono` (the default) suits an identifier such
   * as a branch; `default` suits a subtitle that is prose — the newest message
   * in a chat.
   */
  subtitleVariant?: 'mono' | 'default';
  meta?: string;
  /** When true, renders the session's status glyph in the eyebrow. */
  live?: boolean;
  /**
   * What the session is doing, from the shared status map. Picks between the
   * working and idle glyphs on a live row; `needsInput` is driven by the flag
   * below, which the attention-ack rules own. Absent falls back to working,
   * which is what every live row drew before the idle glyph existed.
   */
  statusKind?: GlanceableStatusKind | null;
  /**
   * When true, replaces the status glyph / meta with the needs-input glyph
   * and a `NEEDS INPUT` label. Highest priority in the eyebrow row.
   */
  needsInput?: boolean;
  /**
   * Clock time of a `scheduled` row's wake, already formatted in the active
   * language (see `formatScheduledWake`). Only read when `statusKind` is
   * `'scheduled'`; appended to the `SCHEDULED` label as ` · <wake>` when set,
   * omitted when null so a scheduled row with no known wake shows the label
   * alone.
   */
  scheduledWake?: string | null;
  /**
   * Opt-in: when true AND `live` AND `meta` are set (and `needsInput` is
   * false), render the live dot AND the meta text side-by-side instead
   * of choosing one. Default false — Home passes `meta` with `live` and
   * must stay byte-for-byte unchanged. The Agents "Active now" tray
   * opts in so tray rows show a dot beside the relative-time meta.
   */
  metaWhileLive?: boolean;
  /**
   * Optional platform-origin icon rendered in the eyebrow-right cluster.
   * When unset, existing callers (incl. Home `variant='card'`) stay
   * bit-for-bit identical. Suppressed entirely for needs-input rows and
   * for live rows, whose eyebrow draws the status glyph — the one mark
   * the cluster shows there.
   */
  platformIcon?: React.ReactNode;
  onPress?: () => void;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
};

/**
 * The flat list's session row: hue strip at the 14pt gutter, eyebrow, title,
 * subtitle, meta and disclosure mark, with a hairline under every row but the
 * last. Its geometry is the contract's (`apps/mobile/AGENTS.md`, "Flat list
 * rows"), so a caller adds no padding of its own.
 */
export function SessionRow({
  agentLabel,
  agentState = null,
  title,
  subtitle,
  meta,
  live,
  statusKind = null,
  needsInput = false,
  scheduledWake = null,
  metaWhileLive = false,
  platformIcon,
  onPress,
  last,
  subtitleVariant = 'mono',
}: Readonly<SessionRowProps>) {
  const { t } = useTranslation();
  const color = agentState ? stateTint(agentState) : agentColor(agentLabel);
  // A row that is neither live nor waiting recedes behind one that is. A quiet
  // tint (the context placeholder, and idle's neutral strip) is already the
  // quietest mark a row can carry, and multiplying it again erased the strip on
  // the dark page, so only an accent strip dims.
  const dimStrip = !live && !needsInput && !isQuietTint(color);
  const liveKind: GlanceableStatusKind = statusKind === 'idle' ? 'idle' : 'running';

  const eyebrowDecision = selectSessionRowEyebrowRight({
    needsInput,
    scheduled: statusKind === 'scheduled',
    live: Boolean(live),
    hasMeta: Boolean(meta),
    metaWhileLive,
    hasPlatformIcon: platformIcon != null,
  });

  let branchContent: React.ReactNode = null;
  if (eyebrowDecision.kind === 'needs-input') {
    branchContent = (
      <View className="flex-row items-center gap-1.5">
        <SessionStatusIcon kind="needsInput" />
        <Text variant="mono" className="shrink text-xs text-warn">
          {t('sessionRow.needsInput')}
        </Text>
      </View>
    );
  } else if (eyebrowDecision.kind === 'scheduled') {
    branchContent = (
      <View className="min-w-0 shrink flex-row items-center gap-1.5">
        <SessionStatusIcon kind="scheduled" />
        <Text
          variant="mono"
          className="shrink text-xs text-ink2"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {/* i18n-dup-ok: 'sessionRow.scheduled' is the full-caps mono row badge; 'common.scheduled' is the sentence-case connection label and the spoken a11y word, and each locale cases the badge form itself — the same split as sessionRow.needsInput beside glanceable.needsInput. */}
          {scheduledWake
            ? `${t('sessionRow.scheduled')} · ${scheduledWake}`
            : t('sessionRow.scheduled')}
        </Text>
      </View>
    );
  } else if (eyebrowDecision.kind === 'live-and-meta') {
    branchContent = (
      <View className="min-w-0 shrink flex-row items-center gap-1.5">
        <SessionStatusIcon kind={liveKind} />
        <Text
          variant="mono"
          className="shrink text-xs text-ink2"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {meta}
        </Text>
      </View>
    );
  } else if (eyebrowDecision.kind === 'live') {
    branchContent = <SessionStatusIcon kind={liveKind} />;
  } else if (eyebrowDecision.kind === 'meta' && meta) {
    branchContent = (
      <Text
        variant="mono"
        className="shrink text-xs text-ink2"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {meta}
      </Text>
    );
  }

  let eyebrowRight: React.ReactNode = null;
  if (eyebrowDecision.kind === 'needs-input') {
    eyebrowRight = branchContent;
  } else if (eyebrowDecision.showPlatformIcon && platformIcon != null) {
    // `none` kind: icon alone, no extra wrapper. Otherwise wrap icon + branch.
    eyebrowRight =
      branchContent == null ? (
        platformIcon
      ) : (
        <View className="shrink flex-row items-center gap-1.5">
          {platformIcon}
          {branchContent}
        </View>
      );
  } else {
    eyebrowRight = branchContent;
  }

  const titleNode = (
    <Text className="font-medium text-sm tracking-tight text-foreground" numberOfLines={2}>
      {title}
    </Text>
  );

  const row = (
    <View
      className={cn(
        'flex-row items-center gap-3 px-4 py-3',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
    >
      <View
        className={cn(
          'w-[3px] self-stretch rounded-[2px]',
          color.hueClass,
          dimStrip && 'opacity-30'
        )}
      />
      <View className="min-w-0 flex-1">
        <View className="mb-[3px] flex-row items-center justify-between">
          <Eyebrow
            className={cn('min-w-0 flex-1', color.hueTextClass)}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {agentLabel}
          </Eyebrow>
          {eyebrowRight}
        </View>
        {titleNode}
        {subtitle ? (
          <Text
            variant={subtitleVariant}
            className={
              subtitleVariant === 'mono'
                ? 'mt-1 text-xs tracking-[0.3px] text-muted-foreground'
                : 'mt-1 text-xs text-muted-foreground'
            }
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <RowChevron />
    </View>
  );
  if (onPress) {
    return (
      // No caller passes `onPress` today; both session rows wrap this
      // primitive in their own labelled Pressable. A future caller owns its
      // own accessible name.
      <Pressable onPress={onPress} className="active:opacity-70">
        {row}
      </Pressable>
    );
  }
  return row;
}
