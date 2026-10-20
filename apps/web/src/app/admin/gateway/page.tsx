'use client';

import { useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SyncProvidersContent } from '@/app/admin/sync-providers/SyncProvidersContent';
import { CustomLlmsContent } from '@/app/admin/custom-llms/CustomLlmsContent';
import { RoutingContent } from '@/app/admin/gateway/RoutingContent';
import { AutoFreeContent } from '@/app/admin/gateway/AutoFreeContent';
import { GatewayModelListContent } from '@/app/admin/gateway/GatewayModelListContent';
import { VercelModelIdOverridesContent } from '@/app/admin/gateway/VercelModelIdOverridesContent';
import { CustomPricingContent } from '@/app/admin/gateway/CustomPricingContent';
import ApiRequestLogPage from '@/app/admin/api-request-log/page';
import RequestLoggingOptInsContent from '@/app/admin/request-logging-opt-ins/RequestLoggingOptInsContent';

const VALID_TABS: readonly string[] = [
  'sync-providers',
  'custom-llms',
  'routing',
  'auto-free',
  'preferred-models',
  'unavailable-models',
  'custom-pricing',
  'api-request-log',
];
type Tab =
  | 'sync-providers'
  | 'custom-llms'
  | 'routing'
  | 'auto-free'
  | 'preferred-models'
  | 'unavailable-models'
  | 'custom-pricing'
  | 'api-request-log';
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
          <TabsList className="h-auto w-full flex-wrap justify-start gap-x-6 rounded-none border-b bg-transparent p-0">
            <TabsTrigger value="sync-providers" className={tabTriggerClass}>
              Sync Providers
            </TabsTrigger>
            <TabsTrigger value="custom-llms" className={tabTriggerClass}>
              Custom LLMs
            </TabsTrigger>
            <TabsTrigger value="routing" className={tabTriggerClass}>
              Vercel Routing
            </TabsTrigger>
            <TabsTrigger value="auto-free" className={tabTriggerClass}>
              Auto Free
            </TabsTrigger>
            <TabsTrigger value="preferred-models" className={tabTriggerClass}>
              Preferred Models
            </TabsTrigger>
            <TabsTrigger value="unavailable-models" className={tabTriggerClass}>
              Unavailable Models
            </TabsTrigger>
            <TabsTrigger value="custom-pricing" className={tabTriggerClass}>
              Custom Pricing
            </TabsTrigger>
            <TabsTrigger value="api-request-log" className={tabTriggerClass}>
              API Request Log
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sync-providers" className="mt-4">
            <SyncProvidersContent />
          </TabsContent>
          <TabsContent value="custom-llms" className="mt-4">
            <CustomLlmsContent />
          </TabsContent>
          <TabsContent value="routing" className="mt-4 flex flex-col gap-y-6">
            <RoutingContent />
            <VercelModelIdOverridesContent />
          </TabsContent>
          <TabsContent value="auto-free" className="mt-4">
            <AutoFreeContent />
          </TabsContent>
          <TabsContent value="preferred-models" className="mt-4">
            <GatewayModelListContent
              list="preferred_models"
              title="Preferred Models"
              ordered
              description={
                <>
                  Ordered list of preferred model IDs, stored in the <code>preferred_models</code>{' '}
                  column of <code>ai_gateway_config</code>. The model catalog sorts these models
                  first in this order, and every model in the list except <code>kilo-auto/*</code>{' '}
                  is monitored by the model stats and health checks.
                </>
              }
            />
          </TabsContent>
          <TabsContent value="unavailable-models" className="mt-4">
            <GatewayModelListContent
              list="unavailable_models"
              title="Unavailable Models"
              ordered={false}
              description={
                <>
                  Model IDs the gateway hides from the catalog and rejects for direct requests,
                  stored in the <code>unavailable_models</code> column of{' '}
                  <code>ai_gateway_config</code>. <code>kilo-auto</code> can still route to them.{' '}
                  <code>google/gemma-4-26b-a4b-it:free</code> is always unavailable and is not
                  listed here.
                </>
              }
            />
          </TabsContent>
          <TabsContent value="custom-pricing" className="mt-4">
            <CustomPricingContent />
          </TabsContent>
          <TabsContent
            value="api-request-log"
            className="mt-4 [&>div]:mx-0 [&>div]:py-0 [&>header]:hidden"
          >
            <ApiRequestLogPage />
            <div className="mt-8">
              <RequestLoggingOptInsContent />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AdminPage>
  );
}
