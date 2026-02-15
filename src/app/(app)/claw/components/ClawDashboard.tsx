'use client';

import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { InstanceTab } from './InstanceTab';
import { SettingsTab } from './SettingsTab';

export function ClawDashboard({ status }: { status: KiloClawDashboardStatus | undefined }) {
  const mutations = useKiloClawMutations();
  const gatewayUrl = useGatewayUrl(status);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
      />

      <Card className="mt-6">
        {!status?.status ? (
          <CardContent className="p-5">
            <CreateInstanceCard mutations={mutations} />
          </CardContent>
        ) : (
          <Tabs defaultValue="instance">
            <div className="border-b px-4 pt-3">
              <TabsList className="h-auto gap-1 bg-transparent p-0">
                <TabsTrigger
                  value="instance"
                  className="text-muted-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-3 pt-1.5 pb-2.5 text-sm data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Instance
                </TabsTrigger>
                <TabsTrigger
                  value="settings"
                  className="text-muted-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-3 pt-1.5 pb-2.5 text-sm data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Settings
                </TabsTrigger>
              </TabsList>
            </div>
            <CardContent className="p-5">
              <TabsContent value="instance" className="mt-0">
                <InstanceTab status={status} mutations={mutations} />
              </TabsContent>
              <TabsContent value="settings" className="mt-0">
                <SettingsTab status={status} mutations={mutations} />
              </TabsContent>
            </CardContent>
          </Tabs>
        )}
      </Card>
    </div>
  );
}
