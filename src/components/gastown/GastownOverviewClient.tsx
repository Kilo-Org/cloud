'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Skeleton } from '@/components/ui/skeleton';
import { TownCard } from './TownCard';
import {
  Plus,
  Factory,
  Search,
  ChevronDown,
  BarChart3,
  Hexagon,
  Bot,
  DollarSign,
  Zap,
  BookOpen,
  ArrowRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Types ─────────────────────────────────────────────────────────────

type SortOption = 'latest' | 'oldest' | 'az' | 'za';

const SORT_LABELS: Record<SortOption, string> = {
  latest: 'Latest activity',
  oldest: 'Oldest activity',
  az: 'A → Z',
  za: 'Z → A',
};

type TownOverviewCard = {
  townId: string;
  name: string;
  lastActivityAt: string | null;
  beadCounts: {
    open: number;
    in_progress: number;
    in_review: number;
    closed: number;
    failed: number;
  };
  activeAgents: number;
  activitySparkline: number[];
};

type AggregateStats = {
  totalTowns: number;
  openBeads: number;
  closedLast7d: number;
  activeAgents: number;
  costLast7dMicrodollars: number;
  tokensLast7d: number;
};

type GastownOverviewClientProps = {
  /** 'personal' or org ID */
  mode: 'personal' | 'org';
  organizationId?: string;
  basePath: string;
  onboardingUrl: string;
};

// ── Helpers ───────────────────────────────────────────────────────────

function formatCost(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  return dollars < 0.01 ? '$0.00' : `$${dollars.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}

function sortCards(cards: TownOverviewCard[], sort: SortOption): TownOverviewCard[] {
  const sorted = [...cards];
  switch (sort) {
    case 'latest':
      return sorted.sort((a, b) => {
        if (!a.lastActivityAt && !b.lastActivityAt) return 0;
        if (!a.lastActivityAt) return 1;
        if (!b.lastActivityAt) return -1;
        return b.lastActivityAt.localeCompare(a.lastActivityAt);
      });
    case 'oldest':
      return sorted.sort((a, b) => {
        if (!a.lastActivityAt && !b.lastActivityAt) return 0;
        if (!a.lastActivityAt) return -1;
        if (!b.lastActivityAt) return 1;
        return a.lastActivityAt.localeCompare(b.lastActivityAt);
      });
    case 'az':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'za':
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
  }
}

// ── Component ─────────────────────────────────────────────────────────

export function GastownOverviewClient({
  mode,
  organizationId,
  basePath,
  onboardingUrl,
}: GastownOverviewClientProps) {
  const router = useRouter();
  const trpc = useGastownTRPC();

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('latest');
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const didAutoRedirect = useRef(false);

  // Close sort dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Fetch overview data
  const overviewQuery = useQuery(
    mode === 'personal'
      ? trpc.gastown.getTownOverview.queryOptions()
      : trpc.gastown.getOrgTownOverview.queryOptions({ organizationId: organizationId ?? '' })
  );

  // Auto-redirect for personal mode when no towns
  useEffect(() => {
    if (
      mode === 'personal' &&
      !didAutoRedirect.current &&
      overviewQuery.data &&
      overviewQuery.data.cards.length === 0
    ) {
      didAutoRedirect.current = true;
      router.replace(onboardingUrl);
    }
  }, [overviewQuery.data, router, mode, onboardingUrl]);

  const cards = overviewQuery.data?.cards ?? [];
  const aggregate = overviewQuery.data?.aggregate;
  const showSearch = cards.length > 5;

  const filteredCards = useMemo(() => {
    let result = cards;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(c => c.name.toLowerCase().includes(q));
    }
    return sortCards(result, sort);
  }, [cards, search, sort]);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6">
      {/* Badge adjacent to title; + Town button at far right of header */}
      <SetPageTitle
        title="Gastown"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => router.push(onboardingUrl)}
            className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
          >
            <Plus className="size-3.5" />
            Town
          </Button>
        }
      >
        <Badge variant="beta">beta</Badge>
      </SetPageTitle>

      {/* Loading state */}
      {overviewQuery.isLoading && (
        <div className="mt-8 flex gap-8">
          <div className="flex-1 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="mt-3 h-3 w-32" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
            ))}
          </div>
          <div className="hidden w-60 shrink-0 lg:block">
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {overviewQuery.data && cards.length === 0 && (
        <div className="mt-12 flex flex-col items-center justify-center px-6 py-16 text-center">
          <Factory className="mb-5 size-14 text-white/40" />
          <h3 className="text-xl font-semibold text-white/85">No towns yet</h3>
          <p className="mt-3 max-w-md text-sm text-white/55">
            Create a town to spawn the Mayor and begin delegating work. Your town becomes the
            command center for every rig.
          </p>
          <Button
            variant="primary"
            size="md"
            onClick={() => router.push(onboardingUrl)}
            className="mt-6 gap-2 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
          >
            <Plus className="size-5" />
            Create your first town
          </Button>
        </div>
      )}

      {/* Main content — two-column layout */}
      {overviewQuery.data && cards.length > 0 && (
        <div className="mt-8 flex gap-8">
          {/* Left column — town list */}
          <div className="min-w-0 flex-1">
            {/* Search + Sort controls */}
            <div className="mb-5 flex items-center gap-3">
              {showSearch && (
                <div className="relative flex-1">
                  <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/30" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search towns..."
                    className="h-9 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-2 pr-3 pl-9 text-sm text-white/80 placeholder:text-white/25 focus:border-white/[0.12] focus:outline-none"
                  />
                </div>
              )}
              <div ref={sortRef} className="relative ml-auto">
                <button
                  onClick={() => setSortOpen(v => !v)}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 text-sm text-white/60 transition-colors hover:border-white/[0.12] hover:text-white/80"
                >
                  {SORT_LABELS[sort]}
                  <ChevronDown className="size-3.5" />
                </button>
                <AnimatePresence>
                  {sortOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.12 }}
                      className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-white/[0.08] bg-[#141414] py-1 shadow-xl"
                    >
                      {(Object.keys(SORT_LABELS) as SortOption[]).map(key => (
                        <button
                          key={key}
                          onClick={() => {
                            setSort(key);
                            setSortOpen(false);
                          }}
                          className={`flex w-full px-3 py-2 text-left text-sm transition-colors ${
                            sort === key
                              ? 'text-[color:oklch(95%_0.15_108)]'
                              : 'text-white/60 hover:text-white/80'
                          }`}
                        >
                          {SORT_LABELS[key]}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Town cards */}
            <div className="space-y-3">
              <AnimatePresence mode="popLayout">
                {filteredCards.map((card, i) => (
                  <TownCard
                    key={card.townId}
                    name={card.name}
                    beadCounts={card.beadCounts}
                    lastActivityAt={card.lastActivityAt}
                    activitySparkline={card.activitySparkline}
                    activeAgents={card.activeAgents}
                    index={i}
                    onClick={() => router.push(`${basePath}/${card.townId}`)}
                  />
                ))}
              </AnimatePresence>
              {filteredCards.length === 0 && search.trim() && (
                <p className="py-8 text-center text-sm text-white/40">
                  No towns matching &ldquo;{search.trim()}&rdquo;
                </p>
              )}
            </div>
          </div>

          {/* Right sidebar — aggregate stats + docs */}
          <div className="hidden w-60 shrink-0 lg:block">
            <div className="sticky top-20">
              {aggregate && <AggregateSidebar stats={aggregate} />}
              <DocLinks />
            </div>
          </div>
        </div>
      )}

      {/* Mobile: aggregate stats below cards */}
      {overviewQuery.data && cards.length > 0 && aggregate && (
        <div className="mt-8 lg:hidden">
          <AggregateSidebar stats={aggregate} />
          <DocLinks />
        </div>
      )}
    </div>
  );
}

// ── Aggregate Stats Sidebar ───────────────────────────────────────────

function AggregateSidebar({ stats }: { stats: AggregateStats }) {
  const rows = [
    { label: 'Total Towns', value: stats.totalTowns, icon: BarChart3 },
    { label: 'Open Beads', value: stats.openBeads, icon: Hexagon },
    { label: 'Closed (7d)', value: stats.closedLast7d, icon: Hexagon },
    { label: 'Active Agents', value: stats.activeAgents, icon: Bot },
    { label: 'Cost (7d)', value: formatCost(stats.costLast7dMicrodollars), icon: DollarSign },
    { label: 'Tokens (7d)', value: formatTokens(stats.tokensLast7d), icon: Zap },
  ];

  return (
    <div>
      <h3 className="mb-4 text-xs font-medium tracking-wide text-white/40 uppercase">
        Aggregate Stats
      </h3>
      <div className="space-y-3">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-white/50">
              <row.icon className="size-3.5 text-white/30" />
              {row.label}
            </span>
            <span className="font-mono text-sm font-medium text-white/80">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Documentation Links ───────────────────────────────────────────────

function DocLinks() {
  const links = [
    { label: 'Getting Started', href: '#' },
    { label: 'API Reference', href: '#' },
    { label: 'Troubleshooting', href: '#' },
  ];

  return (
    <div className="mt-8">
      <h3 className="mb-4 flex items-center gap-2 text-xs font-medium tracking-wide text-white/40 uppercase">
        <BookOpen className="size-3.5" />
        Documentation
      </h3>
      <div className="space-y-2.5">
        {links.map(link => (
          <a
            key={link.label}
            href={link.href}
            className="flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white/80"
          >
            <ArrowRight className="size-3.5" />
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}
