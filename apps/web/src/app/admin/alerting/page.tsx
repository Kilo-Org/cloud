'use client';

import { useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertingContent } from '@/app/admin/alerting/AlertingContent';
import { TtfbAlertingContent } from '@/app/admin/alerting-ttfb/TtfbAlertingContent';

const VALID_TABS: readonly string[] = ['error-rate', 'ttfb', 'model-status'];
type Tab = 'error-rate' | 'ttfb' | 'model-status';
const isValidTab = (value: string | null): value is Tab =>
  value !== null && VALID_TABS.includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export default function AdminAlertingPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'error-rate';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'error-rate') {
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
      <BreadcrumbPage>Alerting</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <h2 className="text-2xl font-bold">Alerting</h2>
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
            <TabsTrigger value="error-rate" className={tabTriggerClass}>
              Error Rate
            </TabsTrigger>
            <TabsTrigger value="ttfb" className={tabTriggerClass}>
              TTFB
            </TabsTrigger>
            <TabsTrigger value="model-status" className={tabTriggerClass}>
              Model Status
            </TabsTrigger>
          </TabsList>
          <TabsContent value="error-rate" className="mt-4">
            <AlertingContent />
          </TabsContent>
          <TabsContent value="ttfb" className="mt-4">
            <TtfbAlertingContent />
          </TabsContent>
          <TabsContent value="model-status" className="mt-4">
            <p>Under construction</p>
          </TabsContent>
        </Tabs>
      </div>
    </AdminPage>
  );
}
