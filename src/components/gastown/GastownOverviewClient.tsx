'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PageContainer } from '@/components/layouts/PageContainer';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { SetPageTitle } from '@/components/SetPageTitle';
import { GastownBackdrop } from '@/components/gastown/GastownBackdrop';
import { Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TownCard } from './TownCard';
import { AggregateStatsSidebar } from './AggregateStatsSidebar';

type Town = {
  id: string;
  name: string;
  created_at: string;
};

type GastownOverviewClientProps = {
  towns: Town[];
  onboardingUrl: string;
  onDeleteTown: (townId: string) => void;
  title: string;
  description: string;
  organizationId?: string;
};

export function GastownOverviewClient({ towns, onboardingUrl, onDeleteTown, title, description, organizationId }: GastownOverviewClientProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'latest' | 'oldest' | 'az' | 'za'>('latest');

  const filteredTowns = useMemo(() => {
    let result = towns.filter(town => town.name.toLowerCase().includes(search.toLowerCase()));
    
    result.sort((a, b) => {
      switch (sort) {
        case 'latest': return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'oldest': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'az': return a.name.localeCompare(b.name);
        case 'za': return b.name.localeCompare(a.name);
      }
    });
    
    return result;
  }, [towns, search, sort]);

  // Aggregate stats - placeholder.
  const stats = {
      towns: towns.length,
      agents: { working: 0, idle: 0, stalled: 0, dead: 0, total: 0 },
      beads: { open: 0, inProgress: 0, failed: 0, triageRequests: 0 },
  };

  return (
    <PageContainer>
      <GastownBackdrop contentClassName="p-5 md:p-7">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <SetPageTitle title={title}>
                <Badge variant="beta">beta</Badge>
              </SetPageTitle>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
                {description}
              </p>
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() => router.push(onboardingUrl)}
              className="gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              <Plus className="size-5" />
              New Town
            </Button>
          </div>
        </div>
      </GastownBackdrop>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-white/40" />
              <Input
                placeholder="Search towns..."
                className="pl-9 bg-white/[0.03] border-white/10"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Select value={sort} onValueChange={(v: any) => setSort(v)}>
              <SelectTrigger className="w-[180px] bg-white/[0.03] border-white/10">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
                <SelectItem value="az">A-Z</SelectItem>
                <SelectItem value="za">Z-A</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            {filteredTowns.map(town => (
              <TownCard
                key={town.id}
                town={town}
                onClick={() => organizationId ? router.push(`/organizations/${organizationId}/gastown/${town.id}`) : router.push(`/gastown/${town.id}`)}
                onDelete={e => {
                  e.stopPropagation();
                  if (confirm(`Delete town "${town.name}"?`)) onDeleteTown(town.id);
                }}
              />
            ))}
          </div>
        </div>
        <div className="lg:col-span-1">
          <AggregateStatsSidebar stats={stats} />
        </div>
      </div>
    </PageContainer>
  );
}
