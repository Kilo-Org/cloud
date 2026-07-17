import { Card, CardContent } from '@/components/ui/card';

export type UsageDataPendingStateProps = {
  reducedMotion?: boolean;
};

const usageDataPendingBars = [
  { height: '45%', delay: '0s' },
  { height: '72%', delay: '0.1s' },
  { height: '58%', delay: '0.2s' },
  { height: '88%', delay: '0.3s' },
  { height: '66%', delay: '0.4s' },
  { height: '80%', delay: '0.5s' },
  { height: '52%', delay: '0.6s' },
];

export function UsageDataPendingState({ reducedMotion = false }: UsageDataPendingStateProps) {
  return (
    <Card>
      <CardContent className="flex min-h-128 flex-col items-center justify-center gap-4 p-6 text-center sm:p-10">
        <h2 className="type-heading">Usage data is catching up</h2>
        <UsageDataPendingAnimation reducedMotion={reducedMotion} />
        <p className="type-body text-muted-foreground max-w-md">
          <span className="block">Recent Kilo Gateway activity is still being processed.</span>
          <span className="block">Come back soon to see the latest usage.</span>
        </p>
      </CardContent>
    </Card>
  );
}

function UsageDataPendingAnimation({ reducedMotion }: UsageDataPendingStateProps) {
  return (
    <div
      className={`bg-surface-inset/70 relative h-[150px] w-full max-w-[260px] overflow-hidden rounded-lg p-4 ${
        reducedMotion ? 'usage-pending-static' : ''
      }`}
      aria-hidden="true"
    >
      <div className="border-border absolute inset-x-4 top-[38px] border-t border-dashed" />
      <div className="border-border absolute inset-x-4 top-[84px] border-t border-dashed" />
      <div className="absolute inset-x-4 bottom-4 flex h-[118px] items-end gap-2.5">
        {usageDataPendingBars.map(bar => (
          <div
            key={bar.delay}
            className="bg-surface-overlay animate-usage-pending-bar flex-1 rounded-t-sm"
            style={{ height: bar.height, animationDelay: bar.delay }}
          />
        ))}
      </div>
      <svg
        className="text-primary pointer-events-none absolute inset-4 h-[118px] w-[calc(100%-2rem)]"
        viewBox="0 0 268 118"
        fill="none"
        preserveAspectRatio="none"
      >
        <path
          className="animate-usage-pending-sparkline"
          d="M4 92 L40 80 L76 86 L112 58 L148 66 L184 36 L220 48 L260 24"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength="1"
          strokeDasharray="1"
        />
      </svg>
      <div className="bg-primary animate-usage-pending-endpoint absolute top-9 right-[19px] size-2 rounded-full" />
    </div>
  );
}
