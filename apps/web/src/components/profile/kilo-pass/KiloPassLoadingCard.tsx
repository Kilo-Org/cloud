'use client';

import { Crown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function KiloPassLoadingCard() {
  return (
    <Card className="border-border/60 w-full overflow-hidden rounded-xl shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <span className="bg-muted/40 ring-border/60 grid h-9 w-9 place-items-center rounded-lg ring-1">
              <Crown className="h-5 w-5" />
            </span>

            <span className="leading-none">
              <span className="block text-base">Kilo Pass</span>
              <span className="text-muted-foreground block text-sm font-normal">
                Loading Kilo Pass…
              </span>
            </span>
          </CardTitle>

          <Badge variant="secondary">Loading</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4">
        <div className="bg-muted/20 border-border/60 flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
          <div className="text-muted-foreground text-sm">Billing cadence</div>
          <div className="flex w-44 gap-1 sm:w-56">
            <Skeleton className="h-7 flex-1" />
            <Skeleton className="h-7 flex-1" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="bg-muted/20 border-border/60 rounded-lg border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-3 w-28" />
            <Skeleton className="mt-5 h-3 w-40" />
            <Skeleton className="mt-2 h-3 w-44" />
            <Skeleton className="mt-6 ml-auto h-4 w-16" />
          </div>

          <div className="bg-muted/20 border-border/60 rounded-lg border p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-3 w-28" />
            <Skeleton className="mt-5 h-3 w-40" />
            <Skeleton className="mt-2 h-3 w-44" />
            <Skeleton className="mt-6 ml-auto h-4 w-16" />
          </div>

          <div className="bg-muted/20 border-border/60 hidden rounded-lg border p-4 sm:block">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-3 w-28" />
            <Skeleton className="mt-5 h-3 w-40" />
            <Skeleton className="mt-2 h-3 w-44" />
            <Skeleton className="mt-6 ml-auto h-4 w-16" />
          </div>
        </div>

        <div className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-7" />
          </div>
        </div>

        <div className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-28" />
        </div>

        <div className="text-muted-foreground text-xs">
          Paid credits never expire. Unused bonus credits expire on refill.
        </div>
      </CardContent>
    </Card>
  );
}
