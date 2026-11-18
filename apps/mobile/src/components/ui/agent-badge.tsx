import { View } from 'react-native';

import { agentColor, type Tint } from '@/lib/agent-color';
import { cn } from '@/lib/utils';

type AgentBadgeProps = {
  agent: string;
  /**
   * The tint the caller already resolved for this row. A row whose eyebrow
   * names a state or a placeholder passes it so the strip matches the label
   * instead of hashing the rendered copy (a translation would hash to another
   * hue). Omit it for a real agent name, which hashes as before.
   */
  tint?: Tint;
  variant?: 'strip' | 'square';
  className?: string;
};

/**
 * Per-agent visual anchor.
 * `strip`  — 3px vertical bar, absolute-positioned inside the parent.
 * `square` — 8×8 rounded tile using the agent's tinted background.
 */
export function AgentBadge({
  agent,
  tint,
  variant = 'strip',
  className,
}: Readonly<AgentBadgeProps>) {
  const color = tint ?? agentColor(agent);
  if (variant === 'strip') {
    return (
      <View className={cn('absolute left-0 top-0 bottom-0 w-[3px]', color.hueClass, className)} />
    );
  }
  return (
    <View
      className={cn(
        'h-8 w-8 rounded-md border',
        color.tileBgClass,
        color.tileBorderClass,
        className
      )}
    />
  );
}
