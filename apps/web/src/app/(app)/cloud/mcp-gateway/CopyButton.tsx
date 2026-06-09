'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type CopyButtonProps = {
  value: string;
  toastLabel?: string;
  ariaLabel: string;
  size?: 'icon' | 'sm';
  className?: string;
};

export function CopyButton({
  value,
  toastLabel = 'Copied',
  ariaLabel,
  size = 'icon',
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(toastLabel);
    } catch {
      toast.error('Could not copy');
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size === 'icon' ? 'icon' : 'sm'}
          className={cn('shrink-0', size === 'icon' ? 'size-8' : 'h-8 px-2', className)}
          aria-label={copied ? `${ariaLabel} copied` : ariaLabel}
          onClick={copyValue}
        >
          {copied ? <Check className="size-4 text-foreground" /> : <Copy className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
    </Tooltip>
  );
}
