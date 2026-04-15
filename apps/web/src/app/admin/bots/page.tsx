'use client';

import { useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SlackBotContent } from '@/app/admin/slack-bot/SlackBotContent';
import { BotRequestsContent } from '@/app/admin/bot-requests/BotRequestsContent';

const VALID_TABS: readonly string[] = ['slack-bot', 'kilo-bot'];
type Tab = 'slack-bot' | 'kilo-bot';
const isValidTab = (value: string | null): value is Tab =>
  value !== null && VALID_TABS.includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export default function AdminBotsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const tabParam = searchParams.get('tab');
  const activeTab: Tab = isValidTab(tabParam) ? tabParam : 'slack-bot';

  const onTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'slack-bot') {
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
      <BreadcrumbPage>Kilo Bot</BreadcrumbPage>
    </BreadcrumbItem>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <h2 className="text-2xl font-bold">Kilo Bot</h2>
        <Tabs value={activeTab} onValueChange={onTabChange}>
          <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
            <TabsTrigger value="slack-bot" className={tabTriggerClass}>
              Slack Bot
            </TabsTrigger>
            <TabsTrigger value="kilo-bot" className={tabTriggerClass}>
              Kilo Bot
            </TabsTrigger>
          </TabsList>
          <TabsContent value="slack-bot" className="mt-4">
            <SlackBotContent />
          </TabsContent>
          <TabsContent value="kilo-bot" className="mt-4">
            <BotRequestsContent />
          </TabsContent>
        </Tabs>
      </div>
    </AdminPage>
  );
}
