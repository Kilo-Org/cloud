'use client';

import { Lock, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useCloudAgentSettings } from '@/hooks/useCloudAgentSettings';
import { DefaultSandboxSection } from './DefaultSandboxSection';
import { RepositoryOverridesSection } from './RepositoryOverridesSection';

type CloudAgentSettingsDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CloudAgentSettingsDialog({
  organizationId,
  open,
  onOpenChange,
}: CloudAgentSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(36rem,85vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]">
        <CloudAgentSettings organizationId={organizationId} />
      </DialogContent>
    </Dialog>
  );
}

function CloudAgentSettings({ organizationId }: { organizationId?: string }) {
  const settingsQuery = useCloudAgentSettings({ organizationId });
  const settings = settingsQuery.data;

  return (
    <>
      <DialogHeader className="gap-0 space-y-0 border-b px-6 py-4 text-left">
        <div className="flex items-center gap-2">
          <DialogTitle>Cloud Agent settings</DialogTitle>
          <Badge variant="secondary">{organizationId ? 'Organization' : 'Personal'}</Badge>
        </div>
        {settings && !settings.canManage ? (
          <DialogDescription className="mt-1 flex items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            View only. Organization owners and admins can change these settings.
          </DialogDescription>
        ) : (
          <DialogDescription className="sr-only">
            Choose the sandbox and profile used for new sessions.
          </DialogDescription>
        )}
      </DialogHeader>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="hidden w-44 shrink-0 border-r p-3 sm:block">
          <span
            aria-current="page"
            className="bg-accent text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            General
          </span>
        </nav>

        <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-5">
          {settings ? (
            <>
              <DefaultSandboxSection organizationId={organizationId} settings={settings} />
              <RepositoryOverridesSection organizationId={organizationId} settings={settings} />
            </>
          ) : settingsQuery.isError ? (
            <LoadError onRetry={() => void settingsQuery.refetch()} />
          ) : (
            <LoadingSkeleton />
          )}
        </div>
      </div>
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-8">
      <span className="sr-only">Loading settings...</span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full sm:max-w-sm" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <p className="text-sm">Could not load Cloud Agent settings.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
