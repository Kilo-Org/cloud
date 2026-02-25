'use client';

import { TriangleAlert } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { SettingsTab } from './SettingsTab';
import { ChangelogCard } from './ChangelogCard';
import { PairingCard } from './PairingCard';

type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

function hasPopulatedStatus(
  candidate: KiloClawDashboardStatus | undefined
): candidate is PopulatedClawStatus {
  return candidate !== undefined && candidate.status !== null;
}

export function ClawDashboard({ status }: { status: KiloClawDashboardStatus | undefined }) {
  const mutations = useKiloClawMutations();
  const gatewayUrl = useGatewayUrl(status);
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const {
    data: gatewayStatus,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = useKiloClawGatewayStatus(isRunning);

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={gatewayStatus?.state === 'running'}
      />

      <Alert variant="warning">
        <TriangleAlert className="size-4" />
        <AlertDescription>
          KiloClaw ended up being really popular! We&apos;re working on getting additional capacity.
          If you have trouble starting a machine, please try again in a few minutes.
        </AlertDescription>
      </Alert>

      <Card className="mt-6">
        {!instanceStatus ? (
          <CardContent className="p-5">
            <CreateInstanceCard mutations={mutations} />
          </CardContent>
        ) : (
          <>
            <CardContent className="border-b p-5">
              <InstanceControls status={instanceStatus} mutations={mutations} />
            </CardContent>
            <Tabs defaultValue="instance">
              <div className="px-5">
                <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
                  <TabsTrigger
                    value="instance"
                    className="text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Gateway Process
                  </TabsTrigger>
                  <TabsTrigger
                    value="settings"
                    className="text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-3 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Settings
                  </TabsTrigger>
                </TabsList>
              </div>
              <CardContent className="p-5">
                <TabsContent value="instance" className="mt-0">
                  <InstanceTab
                    status={instanceStatus}
                    gatewayStatus={gatewayStatus}
                    gatewayLoading={gatewayLoading}
                    gatewayError={gatewayError}
                  />
                </TabsContent>
                <TabsContent value="settings" className="mt-0">
                  <SettingsTab status={instanceStatus} mutations={mutations} />
                </TabsContent>
              </CardContent>
            </Tabs>
          </>
        )}
      </Card>

      {instanceStatus?.status === 'running' && <PairingCard mutations={mutations} />}

      <ChangelogCard />
    </div>
  );
}
