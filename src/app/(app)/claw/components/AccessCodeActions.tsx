'use client';

import { Check, Copy, ExternalLink, KeyRound } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAccessCode } from '../hooks/useAccessCode';

const OPEN_BUTTON_ACCENT_CLASS =
  'animate-pulse-once bg-[oklch(95%_0.15_108)] text-black shadow-[0_0_20px_rgba(237,255,0,0.3)] ring-[oklch(95%_0.15_108)]/20 transition-all duration-500 ease-in-out hover:bg-[oklch(95%_0.15_108)]/90 hover:ring-[oklch(95%_0.15_108)]/40';

export function AccessCodeActions({
  canShow,
  gatewayUrl,
}: {
  canShow: boolean;
  gatewayUrl: string;
}) {
  const posthog = usePostHog();
  const { accessCode, isGenerating, isCopied, generateAccessCode, copyAccessCode } =
    useAccessCode();

  if (!canShow) return null;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            onClick={() => {
              posthog?.capture('claw_access_code_clicked');
              generateAccessCode();
            }}
            disabled={isGenerating}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {isGenerating ? 'Generating...' : 'Access Code'}
          </Button>
        </PopoverTrigger>
        {accessCode && (
          <PopoverContent className="w-auto" align="end">
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">One-time code (expires in 10 min)</p>
              <div className="flex items-center gap-2">
                <code className="bg-muted rounded px-3 py-2 font-mono text-lg tracking-widest">
                  {accessCode}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    posthog?.capture('claw_access_code_copied');
                    copyAccessCode();
                  }}
                >
                  {isCopied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </PopoverContent>
        )}
      </Popover>
      <Button
        variant="primary"
        asChild
        className={OPEN_BUTTON_ACCENT_CLASS}
        onClick={() => posthog?.capture('claw_open_clicked', { gateway_url: gatewayUrl })}
      >
        <a href={gatewayUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-2 h-4 w-4" />
          Open
        </a>
      </Button>
    </>
  );
}
