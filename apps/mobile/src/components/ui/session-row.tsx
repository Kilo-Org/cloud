import { ChevronRight } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { AgentBadge } from '@/components/ui/agent-badge';
import { Eyebrow } from '@/components/ui/eyebrow';
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
  /** When true, renders a pulsing good-tone StatusDot before the meta. */
  live?: boolean;
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
  onPress,
  last,
  stripMode = 'edge',
  className,
}: Readonly<SessionRowProps>) {
  const colors = useThemeColors();
  const color = agentColor(agentLabel);
  const dimStrip = !live;
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
          {live && <StatusDot tone="good" />}
          {!live && meta && (
            <Text variant="mono" className="shrink text-xs text-ink2">
              {meta}
            </Text>
          )}
        </View>
        <Text className="text-sm font-medium tracking-tight text-foreground" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            variant="mono"
            className="mt-1 text-xs tracking-[0.3px] text-muted-soft"
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
      <Pressable onPress={onPress} className="active:opacity-70">
        {row}
      </Pressable>
    );
  }
  return row;
}
