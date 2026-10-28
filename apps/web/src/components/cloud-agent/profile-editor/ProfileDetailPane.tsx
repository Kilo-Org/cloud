'use client';

import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  useProfile,
  type useProfileMutations,
  type useCombinedProfileMutations,
} from '@/hooks/useCloudAgentProfiles';
import type { ProfileOwnerType } from '@kilocode/cloud-agent-profile';
import { OverviewTab } from './OverviewTab';
import { VarsTab } from './VarsTab';
import { CommandsTab } from './CommandsTab';
import { McpServersTab } from './McpServersTab';
import { SkillsTab } from './SkillsTab';
import { ProfileAgentsTab } from './ProfileAgentsTab';
import { KiloCommandsTab } from './KiloCommandsTab';
import { InstructionsTab } from './InstructionsTab';
import { ImportConfigTab } from './ImportConfigTab';
import { useCloudAgentSettingsCanManage } from '@/hooks/useCloudAgentSettings';

type ProfileDetailPaneProps = {
  profileId: string;
  ownerType: ProfileOwnerType;
  organizationId?: string;
  isEffectiveDefault: boolean;
  onProfileSelect?: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
};

export function ProfileDetailPane({
  profileId,
  ownerType,
  organizationId,
  isEffectiveDefault,
  onProfileSelect,
  onDelete,
  isDeleting,
  mutations,
}: ProfileDetailPaneProps) {
  const { data: profile, isLoading, error } = useProfile(profileId, { organizationId });
  const { data: permissions } = useCloudAgentSettingsCanManage(
    ownerType === 'organization' ? { organizationId } : {}
  );
  // A personal profile is always editable by its owner; for an organization
  // profile the server rejects non-manager writes, so hide the controls too.
  // Defaults to editable while the permission query loads, matching the
  // repository-bindings dialog.
  const readOnly = ownerType === 'organization' && permissions?.canManage === false;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="text-destructive flex h-full flex-col items-center justify-center gap-2 text-sm">
        <AlertCircle className="h-5 w-5" />
        Failed to load profile
      </div>
    );
  }

  return (
    <Tabs defaultValue="overview" className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
        <h3 className="truncate text-sm font-semibold">{profile.name}</h3>
        {onProfileSelect && (
          <Button variant="outline" size="sm" onClick={onProfileSelect}>
            Use for next task
          </Button>
        )}
      </div>
      {readOnly && (
        <p className="text-muted-foreground shrink-0 border-b px-4 py-2 text-xs" role="note">
          Only organization owners and admins can edit this profile.
        </p>
      )}

      {/* Tabs */}
      <div className="shrink-0 overflow-x-auto border-b px-2 py-1">
        <TabsList aria-label="Profile configuration" className="w-max">
          {(
            [
              { id: 'overview', label: 'Overview', count: null },
              { id: 'vars', label: 'Variables', count: profile.vars.length },
              {
                id: 'commands',
                label: 'Setup',
                count: profile.commands.length,
                title: 'Setup Commands',
              },
              {
                id: 'kilo-commands',
                label: 'Slash Cmds',
                count: profile.kiloCommands.length,
                title: 'Slash Commands',
              },
              { id: 'mcps', label: 'MCP', count: profile.mcpServers.length, title: 'MCP servers' },
              { id: 'skills', label: 'Skills', count: profile.skills.length },
              { id: 'agents', label: 'Agents', count: profile.agents.length },
              { id: 'instructions', label: 'Instructions', count: profile.instructions.length },
              { id: 'import', label: 'Import', count: null },
            ] as const
          ).map(tab => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              title={'title' in tab ? tab.title : undefined}
              className="gap-1 text-xs pointer-coarse:min-h-11"
            >
              {tab.label}
              {tab.count !== null && (
                <span className="bg-muted text-muted-foreground rounded px-1 py-0.5 text-[10px] font-normal leading-none">
                  {tab.count}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabsContent value="overview" className="mt-0">
          <OverviewTab
            profile={profile}
            ownerType={ownerType}
            organizationId={organizationId}
            isEffectiveDefault={isEffectiveDefault}
            mutations={mutations}
            onDelete={onDelete}
            isDeleting={isDeleting}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="vars" className="mt-0">
          <VarsTab
            profileId={profileId}
            organizationId={organizationId}
            vars={profile.vars}
            mutations={mutations}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="commands" className="mt-0">
          <CommandsTab
            profileId={profileId}
            organizationId={organizationId}
            commands={profile.commands}
            mutations={mutations}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="mcps" className="mt-0">
          <McpServersTab
            profileId={profileId}
            organizationId={organizationId}
            mcpServers={profile.mcpServers}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="skills" className="mt-0">
          <SkillsTab
            profileId={profileId}
            organizationId={organizationId}
            skills={profile.skills}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="agents" className="mt-0">
          <ProfileAgentsTab
            profileId={profileId}
            organizationId={organizationId}
            agents={profile.agents}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="kilo-commands" className="mt-0">
          <KiloCommandsTab
            profileId={profileId}
            organizationId={organizationId}
            kiloCommands={profile.kiloCommands}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="instructions" className="mt-0">
          <InstructionsTab instructions={profile.instructions} />
        </TabsContent>
        <TabsContent value="import" className="mt-0">
          <ImportConfigTab
            key={profileId}
            profileId={profileId}
            organizationId={organizationId}
            readOnly={readOnly}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}
