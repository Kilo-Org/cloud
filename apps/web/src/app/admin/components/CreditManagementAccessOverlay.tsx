'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const creditManagementAccessMessage =
  "You don't have access to manage credits. File an access request before adjusting balances.";

export function CreditManagementAccessOverlay({ message = creditManagementAccessMessage }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label="Credit management access required"
          tabIndex={0}
          className="absolute inset-0 z-10 cursor-not-allowed rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-xs">
        {message}
      </TooltipContent>
    </Tooltip>
  );
}
