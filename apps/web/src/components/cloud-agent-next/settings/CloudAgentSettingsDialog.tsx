'use client';

import { useState, type ReactNode } from 'react';
import {
  Boxes,
  Building2,
  Cpu,
  FolderCog,
  LayoutList,
  Lock,
  Palette,
  SlidersHorizontal,
  User,
  type LucideIcon,
} from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { BuiltinAgentsSection } from './BuiltinAgentsSection';
import { DefaultSandboxSection } from './DefaultSandboxSection';
import { EnvironmentsSection } from './EnvironmentsSection';
import { RepositoryOverridesSection } from './RepositoryOverridesSection';
import { SidebarSettingsSection } from './SidebarSettingsSection';
import { TranscriptPreferencesSection } from './TranscriptPreferencesSection';
import { VercelComputeSettings } from './VercelComputeSettings';

export type SettingsSection =
  | 'general'
  | 'profiles'
  | 'environments'
  | 'compute'
  | 'sidebar'
  | 'preferences';

type CloudAgentSettingsDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
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
  onSectionChange,
  onProfileSelect,
  openToNewProfile,
  initialSelectedProfileId,
}: Omit<CloudAgentSettingsDialogProps, 'open' | 'onOpenChange'>) {
  const [section, setSection] = useState(initialSection);
  const [environmentsVisited, setEnvironmentsVisited] = useState(initialSection === 'environments');
  const changeSection = (next: SettingsSection) => {
    setSection(next);
    onSectionChange?.(next);
  };
  const isMobile = useIsMobile();
  const settingsQuery = useCloudAgentSettings({ organizationId });
  const settings = settingsQuery.data;
  const canManage = organizationId ? (settings?.canManage ?? false) : true;
  const activeSection =
    section === 'compute' && settings && !settings.canManage ? 'general' : section;

  return (
    <>
      <DialogHeader className="gap-0 space-y-0 border-b px-6 py-4 text-left">
        <div className="flex flex-wrap items-center gap-2 pr-6">
          <DialogTitle>Cloud Agent settings</DialogTitle>
          <Badge variant="secondary">
            {organizationId ? 'Organization workspace' : 'Personal workspace'}
          </Badge>
        </div>
        {organizationId &&
        settings &&
        !settings.canManage &&
        activeSection !== 'sidebar' &&
        activeSection !== 'preferences' ? (
          <DialogDescription className="mt-1 flex items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            Organization settings are view only. Your personal preferences remain editable.
          </DialogDescription>
        ) : (
          <DialogDescription className="sr-only">
            Choose defaults for new sessions and manage environment profiles.
          </DialogDescription>
        )}
      </DialogHeader>

      <Tabs
        value={activeSection}
        onValueChange={value => {
          if (
            value === 'general' ||
            value === 'profiles' ||
            value === 'environments' ||
            value === 'sidebar' ||
            value === 'preferences' ||
            (value === 'compute' && settings?.canManage)
          ) {
            if (value === 'environments') setEnvironmentsVisited(true);
            changeSection(value);
          }
        }}
        orientation={isMobile ? 'horizontal' : 'vertical'}
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <TabsList
          aria-label="Settings sections"
          className="h-auto min-w-0 shrink-0 justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-3 md:w-44 md:flex-col md:justify-start md:overflow-visible md:border-r md:border-b-0"
        >
          <NavGroupLabel icon={organizationId ? Building2 : FolderCog}>
            {organizationId ? 'Organization' : 'Workspace'}
          </NavGroupLabel>
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
          {settings?.canManage && (
            <TabsTrigger
              value="compute"
              className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
            >
              <Cpu className="size-4" aria-hidden />
              Compute
            </TabsTrigger>
          )}
          <div aria-hidden className="bg-border mx-1 w-px shrink-0 self-stretch md:hidden" />
          <NavGroupLabel icon={User} className="md:mt-3">
            You
          </NavGroupLabel>
          <TabsTrigger
            value="preferences"
            className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
          >
            <Palette className="size-4 shrink-0" aria-hidden />
            Preferences
          </TabsTrigger>
          <TabsTrigger
            value="sidebar"
            className="gap-2 pointer-coarse:min-h-11 md:w-full md:justify-start"
          >
            <LayoutList className="size-4 shrink-0" aria-hidden />
            Sidebar
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="general"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          {settings ? (
            <section aria-labelledby="session-defaults-heading" className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="session-defaults-heading" className="text-base font-medium">
                  {organizationId ? 'Organization settings' : 'Session defaults'}
                </h3>
                <Badge variant="secondary">{organizationId ? 'All members' : 'New sessions'}</Badge>
              </div>
              <DefaultSandboxSection
                organizationId={organizationId}
                settings={settings}
                onRetry={() => void settingsQuery.refetch()}
              />
              <RepositoryOverridesSection
                organizationId={organizationId}
                settings={settings}
                onManageProfiles={() => changeSection('profiles')}
              />
            </section>
          ) : settingsQuery.isError ? (
            <LoadError onRetry={() => void settingsQuery.refetch()} />
          ) : (
            <LoadingSkeleton />
          )}
        </TabsContent>
        <TabsContent
          value="preferences"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          <section aria-labelledby="personal-preferences-heading" className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="personal-preferences-heading" className="text-base font-medium">
                Preferences
              </h3>
              <Badge variant="secondary">
                <User aria-hidden />
                Only you
              </Badge>
            </div>
            <TranscriptPreferencesSection />
            {settings ? (
              <BuiltinAgentsSection organizationId={organizationId} settings={settings} />
            ) : settingsQuery.isError ? (
              <LoadError onRetry={() => void settingsQuery.refetch()} />
            ) : (
              <LoadingSkeleton />
            )}
          </section>
        </TabsContent>
        <TabsContent
          value="environments"
          forceMount
          className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          {environmentsVisited && (
            <EnvironmentsSection
              organizationId={organizationId}
              canManage={canManage}
              active={activeSection === 'environments'}
            />
          )}
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
        <TabsContent
          value="sidebar"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          <SidebarSettingsSection organizationId={organizationId} />
        </TabsContent>
        <TabsContent
          value="compute"
          className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5"
        >
          {settings?.canManage ? (
            <VercelComputeSettings organizationId={organizationId} />
          ) : settingsQuery.isError ? (
            <LoadError onRetry={() => void settingsQuery.refetch()} />
          ) : (
            <LoadingSkeleton />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function NavGroupLabel({
  icon: Icon,
  className,
  children,
}: {
  icon: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'text-muted-foreground hidden items-center gap-1.5 px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide uppercase md:flex md:w-full',
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </div>
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
