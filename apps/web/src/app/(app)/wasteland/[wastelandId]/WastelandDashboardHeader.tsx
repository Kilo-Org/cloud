'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Skull, Globe, Lock, ScrollText, Users, Settings } from 'lucide-react';

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  deleted: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const TABS = [
  { href: 'wanted', label: 'Wanted Board', icon: ScrollText },
  { href: 'members', label: 'Members', icon: Users },
  { href: 'settings', label: 'Settings', icon: Settings },
] as const;

export function WastelandDashboardHeader() {
  const params = useParams<{ wastelandId: string }>();
  const wastelandId = params.wastelandId;
  const pathname = usePathname();
  const trpc = useWastelandTRPC();

  const wastelandQuery = useQuery(trpc.wasteland.getWasteland.queryOptions({ wastelandId }));
  const wasteland = wastelandQuery.data;

  // Derive the base path by stripping the tab segment — handles both
  // /wasteland/[id]/... and /organizations/[orgId]/wasteland/[id]/...
  const wastelandSegmentIndex = pathname.indexOf(`/wasteland/${wastelandId}`);
  const basePath =
    wastelandSegmentIndex >= 0
      ? pathname.slice(0, wastelandSegmentIndex) + `/wasteland/${wastelandId}`
      : `/wasteland/${wastelandId}`;

  // Determine active tab from the path segment after the wastelandId
  const afterBase = pathname.slice(basePath.length);
  const activeSegment = afterBase.split('/')[1] ?? 'wanted';

  return (
    <div className="border-b border-white/[0.06]">
      {/* Top row: icon + name + badges */}
      <div className="flex items-center gap-3 px-6 py-3">
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
                <Badge variant="outline" className="gap-1 border-white/10 text-white/50">
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

      {/* Tab navigation */}
      <nav className="flex gap-1 px-6" aria-label="Wasteland dashboard tabs">
        {TABS.map(tab => {
          const isActive = activeSegment === tab.href;
          const TabIcon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={`${basePath}/${tab.href}`}
              className={`relative flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'text-white/90'
                  : 'text-white/35 hover:bg-white/[0.03] hover:text-white/55'
              }`}
            >
              <TabIcon className="size-3.5" />
              {tab.label}
              {isActive && (
                <span className="absolute inset-x-0 -bottom-px h-px bg-[color:oklch(70%_0.15_30)]" />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
