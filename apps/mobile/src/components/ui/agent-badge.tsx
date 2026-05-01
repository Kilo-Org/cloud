import { View } from 'react-native';

import { agentColor } from '@/lib/agent-color';
import { cn } from '@/lib/utils';

type AgentBadgeProps = {
  agent: string;
  variant?: 'strip' | 'square';
  className?: string;
};

/**
 * Per-agent visual anchor.
 * `strip`  — 3px vertical bar, absolute-positioned inside the parent.
 * `square` — 8×8 rounded tile using the agent's tinted background.
 */
export function AgentBadge({ agent, variant = 'strip', className }: Readonly<AgentBadgeProps>) {
  const color = agentColor(agent);
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
