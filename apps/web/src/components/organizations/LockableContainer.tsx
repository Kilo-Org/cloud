'use client';

import { useLockableContainerContext } from '@/contexts/LockableContainerContext';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReactNode } from 'react';

type LockableContainerProps = {
  children: ReactNode;
  className?: string;
};

export function LockableContainer({ children, className }: LockableContainerProps) {
  const { isLocked, tooltipWhenLocked } = useLockableContainerContext();

  if (!isLocked) {
    return <>{children}</>;
  }

  return (
    <Tooltip>
      <TooltipTrigger className={className} asChild>
        <div className="relative cursor-not-allowed opacity-60">
          <div className="pointer-events-none">{children}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltipWhenLocked}</TooltipContent>
    </Tooltip>
  );
}
