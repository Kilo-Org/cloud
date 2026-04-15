'use client';

import { useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SyncProvidersContent } from '@/app/admin/sync-providers/SyncProvidersContent';
import { CustomLlmsContent } from '@/app/admin/custom-llms/CustomLlmsContent';

const VALID_TABS: readonly string[] = ['sync-providers', 'custom-llms'];
type Tab = 'sync-providers' | 'custom-llms';
const isValidTab = (value: string | null): value is Tab =>
  value !== null && VALID_TABS.includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export default function AdminGatewayPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'sync-providers';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'sync-providers') {
        params.delete('tab');
      } else {
        params.set('tab', value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const breadcrumbs = (
    <BreadcrumbItem>
      <BreadcrumbPage>Gateway</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <h2 className="text-2xl font-bold">Gateway</h2>
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
            <TabsTrigger value="sync-providers" className={tabTriggerClass}>
              Sync Providers
            </TabsTrigger>
            <TabsTrigger value="custom-llms" className={tabTriggerClass}>
              Custom LLMs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sync-providers" className="mt-4">
            <SyncProvidersContent />
          </TabsContent>
          <TabsContent value="custom-llms" className="mt-4">
            <CustomLlmsContent />
          </TabsContent>
        </Tabs>
      </div>
    </AdminPage>
  );
}
