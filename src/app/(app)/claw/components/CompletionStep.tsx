'use client';

import { useEffect, useRef } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import confetti from 'canvas-confetti';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { OpenClawButton } from './OpenClawButton';

type CompletionStepProps = {
  flyRegion: string | null;
  canOpenClaw: boolean;
  gatewayUrl: string;
  onClose: () => void;
};

export function CompletionStep({
  flyRegion,
  canOpenClaw,
  gatewayUrl,
  onClose,
}: CompletionStepProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const confettiStarted = useRef<boolean>(false);

  useEffect(() => {
    if (confettiStarted.current) return;

    const timer = setTimeout(() => {
      const end = Date.now() + 3 * 1000; // 3 seconds
      const colors = ['#a786ff', '#fd8bbc', '#eca184', '#f8deb1'];
      const frame = () => {
        if (Date.now() > end) return;
        void confetti({
          particleCount: 2,
          angle: 60,
          spread: 55,
          startVelocity: 60,
          origin: { x: 0, y: 1 },
          colors: colors,
        });
        void confetti({
          particleCount: 2,
          angle: 120,
          spread: 55,
          startVelocity: 60,
          origin: { x: 1, y: 1 },
          colors: colors,
        });
        requestAnimationFrame(frame);
      };
      frame();
      confettiStarted.current = true;
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Card className="mt-6 overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-6 pt-12">
        <div className="relative">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-700/30 bg-emerald-900/50">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-emerald-500">
              <Check className="h-6 w-6 text-emerald-500" />
            </div>
          </div>
          <div className="absolute -top-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full bg-[#09090b] text-amber-400">
            <Sparkles className="h-4 w-4" />
          </div>
          <span
            ref={anchorRef}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <h2 className="text-2xl font-bold">Your instance is ready!</h2>
          <p className="text-muted-foreground max-w-md text-center">
            KiloClaw has been provisioned and configured with your settings. You&apos;re all set to
            start.
          </p>
        </div>

        {flyRegion && (
          <div className="border-border/50 flex items-center gap-2 rounded-full border px-4 py-2">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="text-muted-foreground flex items-center gap-2 text-sm">
              Active &middot;{' '}
              <span className="text-foreground font-bold">{flyRegion.toUpperCase()}</span> region
            </span>
          </div>
        )}
        <div className="flex w-full flex-col gap-3">
          <OpenClawButton
            canShow={canOpenClaw}
            gatewayUrl={gatewayUrl}
            look="hero"
            label="Open KiloClaw"
            className="w-full py-6 text-base"
          />
          <Button className="w-full py-6 text-base" variant="outline" onClick={onClose}>
            <X className="mr-2 h-4 w-4" />
            Close Wizard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
