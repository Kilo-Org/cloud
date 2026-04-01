'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { Plus, Skull, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type OrgWastelandListPageClientProps = {
  organizationId: string;
  role: string;
};

export function OrgWastelandListPageClient({ organizationId }: OrgWastelandListPageClientProps) {
  const router = useRouter();
  const trpc = useWastelandTRPC();
  const newUrl = `/organizations/${organizationId}/wasteland/new`;

  const wastelandsQuery = useQuery({
    ...trpc.wasteland.listWastelands.queryOptions({ organizationId }),
    refetchInterval: 30_000,
  });

  const wastelands = wastelandsQuery.data ?? [];
  const activeWastelands = wastelands.filter(w => w.status === 'active');

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-3">
          <SetPageTitle title="Wastelands">
            <Badge variant="beta">beta</Badge>
          </SetPageTitle>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="max-w-2xl text-sm leading-relaxed text-white/60">
                A hosted bounty board backed by DoltHub. Post wanted items, claim work, and track
                completions across your organization&rsquo;s projects.
              </p>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => router.push(newUrl)}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Wasteland
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Wastelands</div>
              <div className="mt-0.5 text-lg font-semibold text-white/85">
                {wastelandsQuery.isLoading ? '…' : activeWastelands.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Total</div>
              <div className="mt-0.5 text-lg font-semibold text-white/85">
                {wastelandsQuery.isLoading ? '…' : wastelands.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Backed by</div>
              <div className="mt-1 text-sm text-white/70">DoltHub</div>
            </div>
            <div className="hidden rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 sm:block">
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Scope</div>
              <div className="mt-1 text-sm text-white/70">Organization</div>
            </div>
          </div>
        </div>
      </GastownBackdrop>

      {wastelandsQuery.isLoading && <OrgWastelandListSkeleton />}

      {wastelandsQuery.data && wastelands.length === 0 && (
        <GastownBackdrop>
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <Skull className="mb-4 size-12 text-white/40" />
            <h3 className="text-lg font-semibold text-white/85">No wastelands yet</h3>
            <p className="mt-2 max-w-md text-sm text-white/55">
              Create a wasteland to set up a hosted bounty board for your organization. Connect it
              to DoltHub to track wanted items, claims, and completions.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={() => router.push(newUrl)}
              className="mt-5 gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              Create your first wasteland
            </Button>
          </div>
        </GastownBackdrop>
      )}

      {wastelands.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {wastelands.map(wasteland => (
            <OrgWastelandCard
              key={wasteland.wasteland_id}
              wasteland={wasteland}
              onClick={() =>
                router.push(
                  `/organizations/${organizationId}/wasteland/${wasteland.wasteland_id}`
                )
              }
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

type WastelandItem = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  dolthub_upstream: string | null;
  visibility: 'public' | 'private';
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
};

function OrgWastelandCard({
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
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-base font-medium text-white/90">{wasteland.name}</h3>
          <StatusPill status={wasteland.status} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <VisibilityBadge visibility={wasteland.visibility} />
          {wasteland.dolthub_upstream && (
            <DoltHubLink upstream={wasteland.dolthub_upstream} />
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-white/40">
          <span>
            Created{' '}
            {formatDistanceToNow(new Date(wasteland.created_at), { addSuffix: true })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPill({ status }: { status: 'active' | 'deleted' }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/20">
        <span className="size-1.5 rounded-full bg-emerald-400" />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-400 ring-1 ring-red-500/20">
      <span className="size-1.5 rounded-full bg-red-400" />
      Deleted
    </span>
  );
}

function VisibilityBadge({ visibility }: { visibility: 'public' | 'private' }) {
  if (visibility === 'public') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-white/50">
        <Eye className="size-3" />
        Public
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-white/50">
      <EyeOff className="size-3" />
      Private
    </span>
  );
}

function DoltHubLink({ upstream }: { upstream: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-white/50 hover:text-white/70"
      onClick={e => {
        e.stopPropagation();
        window.open(`https://www.dolthub.com/repositories/${upstream}`, '_blank');
      }}
    >
      <ExternalLink className="size-3" />
      {upstream}
    </span>
  );
}

function OrgWastelandListSkeleton() {
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
