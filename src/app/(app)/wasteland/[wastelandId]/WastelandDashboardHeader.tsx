'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Skull, Globe, Lock } from 'lucide-react';

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  deleted: 'bg-red-500/10 text-red-400 border-red-500/20',
};

export function WastelandDashboardHeader() {
  const params = useParams<{ wastelandId: string }>();
  const wastelandId = params.wastelandId;
  const trpc = useWastelandTRPC();

  const wastelandQuery = useQuery(
    trpc.wasteland.getWasteland.queryOptions({ wastelandId })
  );
  const wasteland = wastelandQuery.data;

  return (
    <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-3">
      {/* Icon */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color:oklch(70%_0.15_30_/_0.15)] ring-1 ring-[color:oklch(70%_0.15_30_/_0.25)]">
        <Skull className="size-4 text-[color:oklch(70%_0.15_30)]" />
      </div>

      {/* Name + badges */}
      {wastelandQuery.isLoading ? (
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-16" />
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-white/90">
            {wasteland?.name ?? 'Wasteland'}
          </h1>
          {wasteland && (
            <>
              <Badge
                variant="outline"
                className={statusStyles[wasteland.status] ?? statusStyles.active}
              >
                {wasteland.status}
              </Badge>
              <Badge
                variant="outline"
                className="gap-1 border-white/10 text-white/50"
              >
                {wasteland.visibility === 'public' ? (
                  <Globe className="size-3" />
                ) : (
                  <Lock className="size-3" />
                )}
                {wasteland.visibility}
              </Badge>
            </>
          )}
        </div>
      )}
    </div>
  );
}
