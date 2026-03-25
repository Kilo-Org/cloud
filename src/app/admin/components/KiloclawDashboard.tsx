'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KiloclawInstancesPage } from './KiloclawInstances/KiloclawInstancesPage';
import { VersionsTab, PinsTab } from './KiloclawVersions/KiloclawVersionsPage';
import { RegionsTab } from './KiloclawRegions/KiloclawRegionsPage';

const VALID_TABS: readonly string[] = ['instances', 'versions', 'pins', 'regions'];
type Tab = 'instances' | 'versions' | 'pins' | 'regions';
const isValidTab = (value: string | null): value is Tab =>
  value !== null && VALID_TABS.includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function KiloclawDashboard() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'instances';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'instances') {
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
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
          <TabsTrigger value="instances" className={tabTriggerClass}>
            Instances
          </TabsTrigger>
          <TabsTrigger value="versions" className={tabTriggerClass}>
            Versions
          </TabsTrigger>
          <TabsTrigger value="pins" className={tabTriggerClass}>
            Pins
          </TabsTrigger>
          <TabsTrigger value="regions" className={tabTriggerClass}>
            Regions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="instances" className="mt-4">
          <KiloclawInstancesPage />
        </TabsContent>
        <TabsContent value="versions" className="mt-4">
          <VersionsTab />
        </TabsContent>
        <TabsContent value="pins" className="mt-4">
          <PinsTab />
        </TabsContent>
        <TabsContent value="regions" className="mt-4">
          <RegionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
