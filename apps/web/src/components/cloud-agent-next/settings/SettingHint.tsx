'use client';

import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type SettingHintProps = {
  label: string;
  children: string;
};

export function SettingHint({ label, children }: SettingHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] pointer-coarse:size-8"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{children}</TooltipContent>
    </Tooltip>
  );
}
