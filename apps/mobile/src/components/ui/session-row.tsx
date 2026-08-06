import * as React from 'react';
import { ChevronRight } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { AgentBadge } from '@/components/ui/agent-badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import { selectSessionRowEyebrowRight } from '@/components/ui/session-row-eyebrow-right';
import { StatusDot } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type SessionRowProps = {
  /** Uppercase label shown in the eyebrow (and hashed for the row hue). */
  agentLabel: string;
  title: string;
  /** Small mono line shown below the title (e.g. git branch). */
  subtitle?: string | null;
  meta?: string;
  /** When true, renders a good-tone StatusDot in the eyebrow. */
  live?: boolean;
  /**
   * When true, replaces the live dot / meta with a pulsing warn-tone dot
   * and a `NEEDS INPUT` label. Highest priority in the eyebrow row.
   */
  needsInput?: boolean;
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
   * bit-for-bit identical. Suppressed entirely for needs-input rows.
   */
  platformIcon?: React.ReactNode;
  onPress?: () => void;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
  /**
   * Where the hue strip is drawn.
   * - `edge` (default): absolute-positioned strip glued to the row's left
   *   edge. Used by Home cards where the strip sits against the card border.
   * - `inline`: strip rendered as an inline flex child, so it respects the
   *   row's horizontal padding. Used by the Agents list rows.
   */
  stripMode?: 'edge' | 'inline';
  className?: string;
};

/**
 * Used by Home and Agents list. Composes agent hue strip + eyebrow +
 * ellipsized title + mono meta + chevron. Hue is deterministically hashed
 * from `agentLabel` so the strip, eyebrow and tile always match.
 */
export function SessionRow({
  agentLabel,
  title,
  subtitle,
  meta,
  live,
  needsInput = false,
  metaWhileLive = false,
  platformIcon,
  onPress,
  last,
  stripMode = 'edge',
  className,
}: Readonly<SessionRowProps>) {
  const colors = useThemeColors();
  const color = agentColor(agentLabel);
  const dimStrip = !live && !needsInput;

  const eyebrowDecision = selectSessionRowEyebrowRight({
    needsInput,
    live: Boolean(live),
    hasMeta: Boolean(meta),
    metaWhileLive,
    hasPlatformIcon: platformIcon != null,
  });

  // Build the branch content EXACTLY as before (no icon wrapper yet).
  // When platformIcon is unset the rendered structure stays bit-for-bit
  // identical to today — no new wrapper around bare Text/StatusDot/null.
  let branchContent: React.ReactNode = null;
  if (eyebrowDecision.kind === 'needs-input') {
    branchContent = (
      <View className="flex-row items-center gap-1.5">
        <StatusDot tone="warn" pulse />
        <Text variant="mono" className="shrink text-xs text-warn">
          NEEDS INPUT
        </Text>
      </View>
    );
  } else if (eyebrowDecision.kind === 'live-and-meta') {
    branchContent = (
      <View className="flex-row items-center gap-1.5">
        <StatusDot tone="good" />
        <Text variant="mono" className="shrink text-xs text-ink2">
          {meta}
        </Text>
      </View>
    );
  } else if (eyebrowDecision.kind === 'live') {
    branchContent = <StatusDot tone="good" />;
  } else if (eyebrowDecision.kind === 'meta' && meta) {
    branchContent = (
      <Text variant="mono" className="shrink text-xs text-ink2">
        {meta}
      </Text>
    );
  }

  let eyebrowRight: React.ReactNode = null;
  if (eyebrowDecision.kind === 'needs-input') {
    // Icon suppressed — render exactly as today.
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

  const row = (
    <View
      className={cn(
        'relative flex-row items-start gap-3 py-[13px] pl-[18px] pr-3',
        !last && 'border-b-[0.5px] border-hair-soft',
        className
      )}
    >
      {stripMode === 'edge' ? (
        <AgentBadge
          agent={agentLabel}
          variant="strip"
          className={dimStrip ? 'opacity-30' : undefined}
        />
      ) : (
        <View
          className={cn(
            'w-[3px] self-stretch rounded-[2px]',
            color.hueClass,
            dimStrip && 'opacity-30'
          )}
        />
      )}
      <View className="min-w-0 flex-1">
        <View className="mb-[3px] flex-row items-center justify-between">
          <Eyebrow className={color.hueTextClass}>{agentLabel}</Eyebrow>
          {eyebrowRight}
        </View>
        <Text className="text-sm font-medium tracking-tight text-foreground" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            variant="mono"
            className="mt-1 text-xs tracking-[0.3px] text-muted-foreground"
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={14} color={colors.mutedSoft} />
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
