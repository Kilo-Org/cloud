'use client';

import { useState, useEffect, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type CopyMessageButtonProps = {
  getText: () => string;
  className?: string;
  label?: string;
};

/**
 * Copy-to-clipboard button for chat messages.
 * Shows a clipboard icon that transitions to a checkmark on success.
 */
export function CopyMessageButton({
  getText,
  className,
  label = 'Copy message',
}: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(getText());
        setCopied(true);
      } catch {
        // silent fail – clipboard may be unavailable in some contexts
      }
    },
    [getText]
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : label}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:min-w-11',
            className
          )}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{copied ? 'Copied!' : label}</TooltipContent>
    </Tooltip>
  );
}
