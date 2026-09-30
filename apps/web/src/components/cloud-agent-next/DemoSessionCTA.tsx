'use client';

import { useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, GitFork } from 'lucide-react';
import type { DemoConfig } from './demo-config';
import { DEMO_SOURCE_REPO } from './demo-config';
import { cn } from '@/lib/utils';

type DemoSessionCTAProps = {
  demo: DemoConfig;
  onAction: () => void;
  isForked: boolean;
  isWaitingForFork: boolean;
  isHighlighted?: boolean;
};

export function DemoSessionCTA({
  demo,
  onAction,
  isForked,
  isWaitingForFork,
  isHighlighted = false,
}: DemoSessionCTAProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll to and focus the card when highlighted
  useEffect(() => {
    if (isHighlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isHighlighted]);

  const getButtonLabel = () => {
    if (isWaitingForFork) {
      return (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Waiting for fork...
        </>
      );
    }
    if (isForked) {
      return 'Show me';
    }
    return (
      <>
        <GitFork className="mr-2 h-4 w-4" />
        Fork {DEMO_SOURCE_REPO} on GitHub
      </>
    );
  };

  return (
    <Card
      id={`demo-${demo.id}`}
      ref={cardRef}
      className={cn(
        'border-muted-foreground/25 border-2 border-dashed transition-all duration-500',
        isHighlighted &&
          'animate-pulse-once bg-[oklch(95%_0.15_108)]/10 shadow-[0_0_30px_rgba(237,255,0,0.4)] ring-2 ring-[oklch(95%_0.15_108)]/50'
      )}
    >
      <CardContent className="flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <Sparkles
            className={cn('h-5 w-5', isHighlighted ? 'text-yellow-400' : 'text-yellow-500')}
          />
          <div>
            <h3 className="font-semibold">{demo.title}</h3>
            <p className="text-muted-foreground text-sm">{demo.description}</p>
          </div>
        </div>
        <Button variant="outline" onClick={onAction} disabled={isWaitingForFork}>
          {getButtonLabel()}
        </Button>
      </CardContent>
    </Card>
  );
}
