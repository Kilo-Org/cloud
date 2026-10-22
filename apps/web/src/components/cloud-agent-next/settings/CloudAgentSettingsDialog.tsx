'use client';

import { useState } from 'react';
import { Boxes, FolderCog, Lock, SlidersHorizontal } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProfilesManager } from '@/components/cloud-agent/profile-editor/ProfilesManager';
import { useCloudAgentSettings } from '@/hooks/useCloudAgentSettings';
import { useIsMobile } from '@/hooks/use-mobile';
import { DefaultSandboxSection } from './DefaultSandboxSection';
import { EnvironmentsSection } from './EnvironmentsSection';
import { RepositoryOverridesSection } from './RepositoryOverridesSection';

type CloudAgentSettingsDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: 'general' | 'profiles' | 'environments';
  onProfileSelect?: (profileId: string) => void;
  openToNewProfile?: boolean;
  initialSelectedProfileId?: string | null;
};

export function CloudAgentSettingsDialog({
  organizationId,
  open,
  onOpenChange,
  ...profileOptions
}: CloudAgentSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(60rem,calc(100dvh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1440px]">
        <CloudAgentSettings
          key={organizationId ?? 'personal'}
          organizationId={organizationId}
          {...profileOptions}
          onProfileSelect={
            profileOptions.onProfileSelect
              ? profileId => {
                  profileOptions.onProfileSelect?.(profileId);
                  onOpenChange(false);
                }
              : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function CloudAgentSettings({
  organizationId,
  initialSection = 'general',
  onProfileSelect,
  openToNewProfile,
  initialSelectedProfileId,
}: Omit<CloudAgentSettingsDialogProps, 'open' | 'onOpenChange'>) {
  const [section, setSection] = useState(initialSection);
  const isMobile = useIsMobile();
  const settingsQuery = useCloudAgentSettings({ organizationId });
  const settings = settingsQuery.data;
  const canManage = organizationId ? (settings?.canManage ?? false) : true;

  return (
    <>
      <DialogHeader className="gap-0 space-y-0 border-b px-6 py-4 text-left">
        <div className="flex items-center gap-2">
          <DialogTitle>Cloud Agent settings</DialogTitle>
          <Badge variant="secondary">{organizationId ? 'Organization' : 'Personal'}</Badge>
        </div>
        {section !== 'profiles' && settings && !settings.canManage ? (
          <DialogDescription className="mt-1 flex items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            View only. Organization owners and admins can change these settings.
          </DialogDescription>
        ) : (
          <DialogDescription className="sr-only">
            Choose defaults for new sessions and manage environment profiles.
          </DialogDescription>
        )}
      </DialogHeader>

      <Tabs
        value={section}
        onValueChange={value => {
          if (value === 'general' || value === 'profiles' || value === 'environments') {
            setSection(value);
          }
        }}
        orientation={isMobile ? 'horizontal' : 'vertical'}
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <TabsList
          aria-label="Settings sections"
          className="h-auto shrink-0 justify-start gap-1 rounded-none border-b bg-transparent p-3 md:w-44 md:flex-col md:justify-start md:border-r md:border-b-0"
        >
          <TabsTrigger
            value="general"
            className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
          >
            <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
            General
          </TabsTrigger>
          <TabsTrigger
            value="environments"
            className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
          >
            <Boxes className="size-4 shrink-0" aria-hidden />
            Environments
          </TabsTrigger>
          <TabsTrigger
            value="profiles"
            className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
          >
            <FolderCog className="size-4 shrink-0" aria-hidden />
            Profiles
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="general"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          <div className="flex flex-col gap-8">
            {settings ? (
              <>
                <DefaultSandboxSection organizationId={organizationId} settings={settings} />
                <RepositoryOverridesSection
                  organizationId={organizationId}
                  settings={settings}
                  onManageProfiles={() => setSection('profiles')}
                />
              </>
            ) : settingsQuery.isError ? (
              <LoadError onRetry={() => void settingsQuery.refetch()} />
            ) : (
              <LoadingSkeleton />
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="environments"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          <EnvironmentsSection organizationId={organizationId} canManage={canManage} />
        </TabsContent>
        <TabsContent
          value="profiles"
          className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <ProfilesManager
            organizationId={organizationId}
            onProfileSelect={onProfileSelect}
            openToNewProfile={openToNewProfile}
            initialSelectedProfileId={initialSelectedProfileId}
          />
        </TabsContent>
      </Tabs>
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
