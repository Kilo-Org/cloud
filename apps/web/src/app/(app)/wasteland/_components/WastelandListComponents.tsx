import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ExternalLink } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export type WastelandItem = WastelandOutputs['wasteland']['listWastelands'][number];

export function WastelandCard({
  wasteland,
  onClick,
}: {
  wasteland: WastelandItem;
  onClick: () => void;
}) {
  return (
    <Card
      className="cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color] hover:border-white/20 hover:bg-white/[0.05]"
      onClick={onClick}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <h3 className="truncate text-base font-medium text-white/90">{wasteland.name}</h3>

        <div className="flex flex-wrap items-center gap-2">
          {wasteland.dolthub_upstream && <DoltHubLink upstream={wasteland.dolthub_upstream} />}
        </div>

        <div className="flex items-center justify-between text-xs text-white/40">
          <span>
            Created {formatDistanceToNow(new Date(wasteland.created_at), { addSuffix: true })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function DoltHubLink({ upstream }: { upstream: string }) {
  return (
    <a
      href={`https://www.dolthub.com/repositories/${upstream}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-white/50 hover:text-white/70"
      onClick={e => e.stopPropagation()}
    >
      <ExternalLink className="size-3" />
      {upstream}
    </a>
  );
}

export function WastelandListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="border-white/10 bg-white/[0.03]">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-24" />
            </div>
            <Skeleton className="h-4 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
