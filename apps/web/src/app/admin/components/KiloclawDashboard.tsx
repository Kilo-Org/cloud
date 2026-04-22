'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KiloclawInstancesPage } from './KiloclawInstances/KiloclawInstancesPage';
import { KiloclawOrphansTab } from './KiloclawInstances/KiloclawOrphansTab';
import { VersionsTab, PinsTab } from './KiloclawVersions/KiloclawVersionsPage';
import { RegionsTab } from './KiloclawRegions/KiloclawRegionsPage';
import { CliRunsTab } from './KiloclawCliRuns/KiloclawCliRunsTab';
import { KiloclawSecurityAdvisorContentTab } from './KiloclawSecurityAdvisorContent/KiloclawSecurityAdvisorContentTab';
import { KiloclawProvidersTab } from './KiloclawProvidersTab';

const VALID_TABS: readonly string[] = [
  'instances',
  'orphans',
  'versions',
  'pins',
  'regions',
  'providers',
  'cli-runs',
  'shell-security-content',
];
type Tab =
  | 'instances'
  | 'orphans'
  | 'versions'
  | 'pins'
  | 'regions'
  | 'providers'
  | 'cli-runs'
  | 'shell-security-content';
const isValidTab = (value: string | null): value is Tab =>
  value !== null && VALID_TABS.includes(value);

// Legacy tab value from before the ShellSecurity rename. Redirect any bookmarks
// to the new tab value. Remove 30 days after launch (~2026-05-22) once bookmark
// traffic has migrated.
//
// Map (not plain object) so prototype keys like `__proto__` / `constructor` /
// `toString` from a crafted `?tab=` value cannot resolve to a non-Tab value
// and get written back into the URL.
const LEGACY_TAB_REDIRECTS: ReadonlyMap<string, Tab> = new Map([
  ['security-advisor-content', 'shell-security-content'],
]);

function resolveTab(tabParam: string | null): Tab {
  if (tabParam === null) return 'instances';
  if (isValidTab(tabParam)) return tabParam;
  return LEGACY_TAB_REDIRECTS.get(tabParam) ?? 'instances';
}

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function KiloclawDashboard() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab = resolveTab(tabParam);

  // Rewrite a deprecated tab value in the URL so bookmarks to
  // ?tab=security-advisor-content persist as the new name on navigation.
  // `resolveTab` already handles the first-render state so the tab content
  // doesn't flash while the effect fires.
  useEffect(() => {
    if (tabParam === null || isValidTab(tabParam)) return;
    const canonical = LEGACY_TAB_REDIRECTS.get(tabParam);
    if (canonical === undefined) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', canonical);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [tabParam, searchParams, router, pathname]);

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
          <TabsTrigger value="orphans" className={tabTriggerClass}>
            Orphans
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
          <TabsTrigger value="providers" className={tabTriggerClass}>
            Providers
          </TabsTrigger>
          <TabsTrigger value="cli-runs" className={tabTriggerClass}>
            CLI Runs
          </TabsTrigger>
          <TabsTrigger value="shell-security-content" className={tabTriggerClass}>
            ShellSecurity Content
          </TabsTrigger>
        </TabsList>
        <TabsContent value="instances" className="mt-4">
          <KiloclawInstancesPage />
        </TabsContent>
        <TabsContent value="orphans" className="mt-4">
          <KiloclawOrphansTab />
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
        <TabsContent value="providers" className="mt-4">
          <KiloclawProvidersTab />
        </TabsContent>
        <TabsContent value="cli-runs" className="mt-4">
          <CliRunsTab />
        </TabsContent>
        <TabsContent value="shell-security-content" className="mt-4">
          <KiloclawSecurityAdvisorContentTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
