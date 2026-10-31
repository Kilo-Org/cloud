import { type ReactNode } from 'react';

import { Text } from '@/components/ui/text';

type InlineBadgeProps = Readonly<{
  children: ReactNode;
}>;

/**
 * A compact bordered status label for row metadata: an agent's mode, a slash
 * command's subtask flag, a repository binding's platform. The border is what
 * separates it from the plain uppercase metadata text that sits beside it in
 * the same row.
 */
export function InlineBadge({ children }: InlineBadgeProps) {
  return (
    <Text className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </Text>
  );
}
