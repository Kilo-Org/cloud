'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { BeadsTab } from './BeadsTab';
import { AgentsTab } from './AgentsTab';
import { ReviewQueueTab } from './ReviewQueueTab';
import { ContainerTab } from './ContainerTab';
import { ConfigTab } from './ConfigTab';
import { EventsTab } from './EventsTab';
import Link from 'next/link';

const VALID_TABS = ['beads', 'agents', 'review', 'container', 'config', 'events'] as const;
type Tab = (typeof VALID_TABS)[number];

function isValidTab(value: string | null): value is Tab {
  return value !== null && (VALID_TABS as readonly string[]).includes(value);
}

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function TownInspectorDashboard({ townId }: { townId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'beads';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'beads') {
        params.delete('tab');
      } else {
        params.set('tab', value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Town Inspector</h1>
          <p className="text-muted-foreground font-mono text-sm">{townId}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/gastown/${townId}`}>View Town UI</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/gastown/towns/${townId}/audit`}>Audit Log</Link>
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
          <TabsTrigger value="beads" className={tabTriggerClass}>
            Beads
          </TabsTrigger>
          <TabsTrigger value="agents" className={tabTriggerClass}>
            Agents
          </TabsTrigger>
          <TabsTrigger value="review" className={tabTriggerClass}>
            Review Queue
          </TabsTrigger>
          <TabsTrigger value="container" className={tabTriggerClass}>
            Container
          </TabsTrigger>
          <TabsTrigger value="config" className={tabTriggerClass}>
            Config
          </TabsTrigger>
          <TabsTrigger value="events" className={tabTriggerClass}>
            Events
          </TabsTrigger>
        </TabsList>

        <TabsContent value="beads" className="mt-4">
          <BeadsTab townId={townId} />
        </TabsContent>
        <TabsContent value="agents" className="mt-4">
          <AgentsTab townId={townId} />
        </TabsContent>
        <TabsContent value="review" className="mt-4">
          <ReviewQueueTab townId={townId} />
        </TabsContent>
        <TabsContent value="container" className="mt-4">
          <ContainerTab townId={townId} />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ConfigTab townId={townId} />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventsTab townId={townId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
