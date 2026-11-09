'use client';

import { Hammer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useCloudAgentSettingsCanManage } from '@/hooks/useCloudAgentSettings';
import { EnvironmentBuildPanel } from './EnvironmentBuildPanel';

/**
 * Opens the environment's snapshot build after a start failed because the
 * environment snapshot is missing, building, failed or cannot start. The panel
 * shows the real build state and lets a manager rebuild it.
 */
export function EnvironmentBuildRecovery({
  environmentId,
  organizationId,
}: {
  environmentId: string;
  organizationId?: string;
}) {
  const { data } = useCloudAgentSettingsCanManage({ organizationId });
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="mt-2 mr-2">
          <Hammer className="mr-2 size-4" />
          View environment build
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Environment build</DialogTitle>
          <DialogDescription>
            Sessions in this environment start only from its snapshot. Send a message to retry once
            the snapshot is ready.
          </DialogDescription>
        </DialogHeader>
        <EnvironmentBuildPanel
          organizationId={organizationId}
          environmentId={environmentId}
          canManage={data?.canManage ?? false}
          hasUnsavedChanges={false}
        />
      </DialogContent>
    </Dialog>
  );
}
