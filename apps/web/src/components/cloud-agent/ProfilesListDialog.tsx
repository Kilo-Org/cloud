/** Dialog to list and manage all environment profiles with list+detail layout. */
'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FolderCog,
  Star,
  Plus,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Check,
  Trash2,
  Key,
  Terminal,
  Building,
  User,
  GitBranch,
  Link2Off,
  Link2,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import {
  useProfiles,
  useCombinedProfiles,
  useProfile,
  useProfileMutations,
  useCombinedProfileMutations,
  useRepoBindings,
  useBindRepoMutation,
  useUnbindRepoMutation,
  type ProfileSummaryWithOwner,
  type ProfileVar,
} from '@/hooks/useCloudAgentProfiles';
import type { ProfileOwnerType } from '@kilocode/cloud-agent-profile';
import { McpServersTab } from './profile-editor/McpServersTab';
import { SkillsTab } from './profile-editor/SkillsTab';
import { ProfileAgentsTab } from './profile-editor/ProfileAgentsTab';
import { KiloCommandsTab } from './profile-editor/KiloCommandsTab';

type ProfilesListDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProfileSelect?: (profileId: string) => void;
  openToNewProfile?: boolean;
  /** If provided, the dialog opens with this profile pre-selected for editing. */
  initialSelectedProfileId?: string | null;
};

export function ProfilesListDialog({
  organizationId,
  open,
  onOpenChange,
  onProfileSelect,
  openToNewProfile,
  initialSelectedProfileId,
}: ProfilesListDialogProps) {
  const combinedQuery = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: open && !!organizationId,
  });
  const regularQuery = useProfiles({
    organizationId: undefined,
    enabled: open && !organizationId,
  });

  const isLoading = organizationId ? combinedQuery.isLoading : regularQuery.isLoading;
  const error = organizationId ? combinedQuery.error : regularQuery.error;

  const orgProfiles = organizationId ? (combinedQuery.data?.orgProfiles ?? []) : [];
  const personalProfiles = organizationId
    ? (combinedQuery.data?.personalProfiles ?? [])
    : (regularQuery.data ?? []).map(p => ({ ...p, ownerType: 'user' as const }));
  const effectiveDefaultId = organizationId ? combinedQuery.data?.effectiveDefaultId : null;
  const allProfiles: ProfileSummaryWithOwner[] = [...orgProfiles, ...personalProfiles];

  const combinedMutations = useCombinedProfileMutations({ organizationId: organizationId ?? '' });
  const regularMutations = useProfileMutations({ organizationId: undefined });
  const mutations = organizationId ? combinedMutations : regularMutations;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDescription, setNewProfileDescription] = useState('');
  const [newProfileOwnerType, setNewProfileOwnerType] = useState<'personal' | 'organization'>(
    'personal'
  );
  const [savingNew, setSavingNew] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Open in "new profile" mode if requested
  useEffect(() => {
    if (open && openToNewProfile) {
      setIsCreating(true);
      setSelectedId(null);
      setNewProfileName('');
      setNewProfileDescription('');
      setNewProfileOwnerType('personal');
    }
  }, [open, openToNewProfile]);

  // When the caller asks us to open to a specific profile, honor it on open.
  useEffect(() => {
    if (open && !openToNewProfile && initialSelectedProfileId) {
      setSelectedId(initialSelectedProfileId);
      setIsCreating(false);
    }
  }, [open, openToNewProfile, initialSelectedProfileId]);

  // Select first profile when list loads and nothing is selected
  useEffect(() => {
    if (!isCreating && !selectedId && allProfiles.length > 0) {
      setSelectedId(allProfiles[0]?.id ?? null);
    }
  }, [allProfiles, selectedId, isCreating]);

  const handleDelete = async (profile: ProfileSummaryWithOwner) => {
    setDeletingId(profile.id);
    try {
      const profileOrgId = profile.ownerType === 'organization' ? organizationId : undefined;
      if (organizationId) {
        await combinedMutations.deleteProfile.mutateAsync({
          profileId: profile.id,
          organizationId: profileOrgId,
        });
      } else {
        await regularMutations.deleteProfile.mutateAsync({
          profileId: profile.id,
          organizationId: undefined,
        });
      }
      toast.success(`Profile "${profile.name}" deleted`);
      if (selectedId === profile.id) setSelectedId(null);
    } catch {
      toast.error('Failed to delete profile');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) {
      toast.error('Profile name is required');
      return;
    }
    setSavingNew(true);
    try {
      const createOrgId =
        organizationId && newProfileOwnerType === 'organization' ? organizationId : undefined;
      const created = await mutations.createProfile.mutateAsync({
        name: newProfileName.trim(),
        description: newProfileDescription.trim() || undefined,
        organizationId: createOrgId,
      });
      toast.success(`Profile "${newProfileName}" created`);
      setIsCreating(false);
      setNewProfileName('');
      setNewProfileDescription('');
      if (created?.id) setSelectedId(created.id);
    } catch {
      toast.error('Failed to create profile');
    } finally {
      setSavingNew(false);
    }
  };

  const isEffectiveDefault = (profile: ProfileSummaryWithOwner) =>
    organizationId ? profile.id === effectiveDefaultId : profile.isDefault;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[560px] flex-col gap-0 p-0 sm:max-w-[860px]">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <FolderCog className="h-4 w-4" />
            Manage Profiles
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Left panel — profile list */}
          <div className="flex w-52 flex-shrink-0 flex-col border-r">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-destructive flex flex-col items-center gap-2 py-8 text-center text-xs">
                  <AlertCircle className="h-4 w-4" />
                  Failed to load
                </div>
              ) : (
                <div className="py-1">
                  {organizationId && orgProfiles.length > 0 && (
                    <>
                      <p className="text-muted-foreground px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider">
                        Organization
                      </p>
                      {orgProfiles.map(p => (
                        <ProfileListItem
                          key={p.id}
                          profile={p}
                          isSelected={selectedId === p.id}
                          isEffectiveDefault={isEffectiveDefault(p)}
                          onSelect={() => {
                            setSelectedId(p.id);
                            setIsCreating(false);
                          }}
                        />
                      ))}
                    </>
                  )}
                  {personalProfiles.length > 0 && (
                    <>
                      {organizationId && (
                        <p className="text-muted-foreground mt-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider">
                          Personal
                        </p>
                      )}
                      {personalProfiles.map(p => (
                        <ProfileListItem
                          key={p.id}
                          profile={p}
                          isSelected={selectedId === p.id}
                          isEffectiveDefault={isEffectiveDefault(p)}
                          onSelect={() => {
                            setSelectedId(p.id);
                            setIsCreating(false);
                          }}
                        />
                      ))}
                    </>
                  )}
                  {allProfiles.length === 0 && !isCreating && (
                    <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                      No profiles yet.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* New profile button */}
            <div className="border-t p-2">
              <button
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
                  'text-muted-foreground hover:bg-accent hover:text-foreground',
                  isCreating && 'bg-accent text-foreground'
                )}
                onClick={() => {
                  setIsCreating(true);
                  setSelectedId(null);
                  setNewProfileName('');
                  setNewProfileDescription('');
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                New profile
              </button>
            </div>
          </div>

          {/* Right panel — detail view */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isCreating ? (
              <NewProfilePane
                organizationId={organizationId}
                name={newProfileName}
                description={newProfileDescription}
                ownerType={newProfileOwnerType}
                onNameChange={setNewProfileName}
                onDescriptionChange={setNewProfileDescription}
                onOwnerTypeChange={setNewProfileOwnerType}
                onSave={handleCreateProfile}
                onCancel={() => {
                  setIsCreating(false);
                  if (allProfiles.length > 0) setSelectedId(allProfiles[0]?.id ?? null);
                }}
                isSaving={savingNew}
              />
            ) : selectedId ? (
              <ProfileDetailPane
                profileId={selectedId}
                ownerType={allProfiles.find(p => p.id === selectedId)?.ownerType ?? 'user'}
                organizationId={
                  allProfiles.find(p => p.id === selectedId)?.ownerType === 'organization'
                    ? organizationId
                    : undefined
                }
                isEffectiveDefault={
                  !!allProfiles.find(p => p.id === selectedId && isEffectiveDefault(p))
                }
                onProfileSelect={
                  onProfileSelect
                    ? () => {
                        onProfileSelect(selectedId);
                        onOpenChange(false);
                      }
                    : undefined
                }
                onDelete={() => {
                  const profile = allProfiles.find(p => p.id === selectedId);
                  if (profile) void handleDelete(profile);
                }}
                isDeleting={deletingId === selectedId}
                mutations={mutations}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-muted-foreground text-sm">Select a profile to view details</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------
// ProfileListItem
// -------------------------------------------------------------------

type ProfileListItemProps = {
  profile: ProfileSummaryWithOwner;
  isSelected: boolean;
  isEffectiveDefault: boolean;
  onSelect: () => void;
};

function ProfileListItem({
  profile,
  isSelected,
  isEffectiveDefault,
  onSelect,
}: ProfileListItemProps) {
  return (
    <div
      className={cn(
        'mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors',
        isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent/50 text-muted-foreground'
      )}
      onClick={onSelect}
    >
      {profile.ownerType === 'organization' ? (
        <Building className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <User className="h-3.5 w-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div
          className={cn('flex items-center gap-1 truncate text-sm', isSelected && 'font-medium')}
        >
          <span className="truncate">{profile.name}</span>
          {isEffectiveDefault && <Star className="text-primary h-3 w-3 shrink-0 fill-current" />}
        </div>
        <div className="text-muted-foreground text-[10px]">
          {[
            profile.varCount > 0 && `${profile.varCount}v`,
            profile.mcpServerCount > 0 && `${profile.mcpServerCount}m`,
            profile.skillCount > 0 && `${profile.skillCount}s`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// NewProfilePane
// -------------------------------------------------------------------

type NewProfilePaneProps = {
  organizationId?: string;
  name: string;
  description: string;
  ownerType: 'personal' | 'organization';
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onOwnerTypeChange: (v: 'personal' | 'organization') => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
};

function NewProfilePane({
  organizationId,
  name,
  description,
  ownerType,
  onNameChange,
  onDescriptionChange,
  onOwnerTypeChange,
  onSave,
  onCancel,
  isSaving,
}: NewProfilePaneProps) {
  return (
    <div className="space-y-4 p-4">
      <h3 className="text-sm font-semibold">New Profile</h3>

      {organizationId && (
        <div className="grid gap-1.5">
          <Label className="text-xs">Owner</Label>
          <div className="flex gap-1.5">
            {(
              [
                { value: 'personal', label: 'Personal', Icon: User },
                { value: 'organization', label: 'Organization', Icon: Building },
              ] as const
            ).map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors',
                  ownerType === value
                    ? 'border-primary bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
                onClick={() => onOwnerTypeChange(value)}
                disabled={isSaving}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="new-profile-name">Name</Label>
        <Input
          id="new-profile-name"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="e.g. Backend debugging"
          autoFocus
          onKeyDown={e => e.key === 'Enter' && !isSaving && onSave()}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-profile-desc">Description</Label>
        <Textarea
          id="new-profile-desc"
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          placeholder="Optional description"
          rows={2}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving || !name.trim()}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
        </Button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// ProfileDetailPane
// -------------------------------------------------------------------

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

function ProfileDetailPane({
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
  const [activeTab, setActiveTab] = useState<
    'overview' | 'vars' | 'commands' | 'mcps' | 'skills' | 'agents' | 'kilo-commands'
  >('overview');

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
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
        <h3 className="truncate text-sm font-semibold">{profile.name}</h3>
        {onProfileSelect && (
          <Button variant="outline" size="sm" onClick={onProfileSelect}>
            Use for next task
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 border-b">
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
          ] as const
        ).map(tab => (
          <button
            key={tab.id}
            title={'title' in tab ? tab.title : undefined}
            className={cn(
              'flex items-center gap-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.count !== null && (
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[10px] font-normal leading-none',
                  activeTab === tab.id
                    ? 'bg-primary/15 text-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && (
          <OverviewTab
            profile={profile}
            ownerType={ownerType}
            organizationId={organizationId}
            isEffectiveDefault={isEffectiveDefault}
            mutations={mutations}
            onDelete={onDelete}
            isDeleting={isDeleting}
          />
        )}
        {activeTab === 'vars' && (
          <VarsTab
            profileId={profileId}
            organizationId={organizationId}
            vars={profile.vars}
            mutations={mutations}
          />
        )}
        {activeTab === 'commands' && (
          <CommandsTab
            profileId={profileId}
            organizationId={organizationId}
            commands={profile.commands}
            mutations={mutations}
          />
        )}
        {activeTab === 'mcps' && (
          <McpServersTab
            profileId={profileId}
            organizationId={organizationId}
            mcpServers={profile.mcpServers}
          />
        )}
        {activeTab === 'skills' && (
          <SkillsTab
            profileId={profileId}
            organizationId={organizationId}
            skills={profile.skills}
          />
        )}
        {activeTab === 'agents' && (
          <ProfileAgentsTab
            profileId={profileId}
            organizationId={organizationId}
            agents={profile.agents}
          />
        )}
        {activeTab === 'kilo-commands' && (
          <KiloCommandsTab
            profileId={profileId}
            organizationId={organizationId}
            kiloCommands={profile.kiloCommands}
          />
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// AutoSaveField — always-visible scalar field that commits on blur/Enter.
//
// Matches the industry pattern for inline-editable text in admin panels
// (Notion, Linear, GitHub). On blur (or Enter for single-line inputs) the
// current value is committed via `onSave`; while saving we show a subtle
// "Saving…" label, and after success we briefly show "Saved". If `onSave`
// throws, the draft is reverted to the last-saved value so the user doesn't
// end up staring at a value that was silently rejected.
// -------------------------------------------------------------------

type AutoSaveFieldProps = {
  kind: 'input' | 'textarea';
  id: string;
  label: string;
  placeholder?: string;
  initialValue: string;
  /** Returns the canonical value that was actually persisted (e.g. trimmed). */
  onSave: (value: string) => Promise<string>;
};

function AutoSaveField({ kind, id, label, placeholder, initialValue, onSave }: AutoSaveFieldProps) {
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const commit = async () => {
    if (value === savedValue) return;
    setStatus('saving');
    try {
      const persisted = await onSave(value);
      setSavedValue(persisted);
      setValue(persisted);
      setStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus('idle'), 1500);
    } catch {
      // Revert on failure so the rendered value matches what's on the server.
      // Error toast is surfaced by `onSave`.
      setValue(savedValue);
      setStatus('idle');
    }
  };

  const commonProps = {
    id,
    value,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(e.target.value),
    onBlur: () => {
      void commit();
    },
    disabled: status === 'saving',
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        {status === 'saving' && <span className="text-muted-foreground text-[10px]">Saving…</span>}
        {status === 'saved' && <span className="text-muted-foreground text-[10px]">Saved</span>}
      </div>
      {kind === 'input' ? (
        <Input
          {...commonProps}
          className="h-8 text-sm"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Textarea {...commonProps} rows={2} className="text-sm" />
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// OverviewTab
// -------------------------------------------------------------------

type OverviewTabProps = {
  profile: NonNullable<ReturnType<typeof useProfile>['data']>;
  ownerType: ProfileOwnerType;
  organizationId?: string;
  isEffectiveDefault: boolean;
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
  onDelete: () => void;
  isDeleting: boolean;
};

function OverviewTab({
  profile,
  ownerType,
  organizationId,
  isEffectiveDefault,
  mutations,
  onDelete,
  isDeleting,
}: OverviewTabProps) {
  const [togglingDefault, setTogglingDefault] = useState(false);

  const handleToggleDefault = async () => {
    setTogglingDefault(true);
    try {
      if (profile.isDefault) {
        await mutations.clearDefault.mutateAsync({ profileId: profile.id, organizationId });
        toast.success(`"${profile.name}" is no longer the default`);
      } else {
        await mutations.setAsDefault.mutateAsync({ profileId: profile.id, organizationId });
        toast.success(`"${profile.name}" is now the default`);
      }
    } catch {
      toast.error('Failed to update default');
    } finally {
      setTogglingDefault(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Name */}
      <AutoSaveField
        key={`name-${profile.id}`}
        kind="input"
        id={`name-${profile.id}`}
        label="Name"
        placeholder="Profile name"
        initialValue={profile.name}
        onSave={async value => {
          const trimmed = value.trim();
          if (!trimmed) {
            toast.error('Name is required');
            throw new Error('Name is required');
          }
          // Only send the changed field — sending stale `description`
          // here can clobber a concurrent description autosave.
          await mutations.updateProfile.mutateAsync({
            profileId: profile.id,
            name: trimmed,
            organizationId,
          });
          return trimmed;
        }}
      />

      {/* Description */}
      <AutoSaveField
        key={`desc-${profile.id}`}
        kind="textarea"
        id={`desc-${profile.id}`}
        label="Description"
        placeholder="Optional description"
        initialValue={profile.description ?? ''}
        onSave={async value => {
          const trimmed = value.trim();
          // Only send the changed field — sending stale `name` here
          // can clobber a concurrent name autosave.
          await mutations.updateProfile.mutateAsync({
            profileId: profile.id,
            description: trimmed || undefined,
            organizationId,
          });
          return trimmed;
        }}
      />

      {/* Default toggle */}
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Star className={cn('h-4 w-4', isEffectiveDefault && 'text-primary fill-current')} />
            {ownerType === 'organization' ? 'Organization default' : 'Personal default'}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {ownerType === 'organization'
              ? 'Auto-loaded for org members who have no personal default and no repo profile'
              : 'Auto-loaded when no repo profile is set (overrides any org default)'}
          </p>
        </div>
        <Switch
          checked={profile.isDefault}
          onCheckedChange={handleToggleDefault}
          disabled={togglingDefault}
        />
      </div>

      {/* Repo bindings */}
      <RepoPinsSection profileId={profile.id} organizationId={organizationId} />

      {/* Delete profile */}
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Trash2 className="text-destructive h-4 w-4" />
            Delete profile
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Permanently removes this profile and its settings. This cannot be undone.
          </p>
        </div>
        <InlineDeleteConfirmation
          onDelete={onDelete}
          isLoading={isDeleting}
          showAsButton
          buttonText="Delete"
        />
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// RepoPinsSection — shows repos this profile is bound to, with add/remove
// -------------------------------------------------------------------

type RepoOption = { id: number; fullName: string; private: boolean; platform: 'github' | 'gitlab' };

function RepoPinsSection({
  profileId,
  organizationId,
}: {
  profileId: string;
  organizationId?: string;
}) {
  const trpc = useTRPC();
  const { data: bindings, isLoading } = useRepoBindings({ organizationId });
  const unbind = useUnbindRepoMutation(organizationId);
  const bind = useBindRepoMutation(organizationId);

  const [isAdding, setIsAdding] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoPopoverOpen, setRepoPopoverOpen] = useState(false);

  const ghOptions = organizationId
    ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
        organizationId,
        forceRefresh: false,
      })
    : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({ forceRefresh: false });
  const glOptions = organizationId
    ? trpc.organizations.cloudAgentNext.listGitLabRepositories.queryOptions({
        organizationId,
        forceRefresh: false,
      })
    : trpc.cloudAgentNext.listGitLabRepositories.queryOptions({ forceRefresh: false });

  const { data: githubRepoData, isLoading: isLoadingGH } = useQuery({
    ...ghOptions,
    enabled: isAdding,
  });
  const { data: gitlabRepoData, isLoading: isLoadingGL } = useQuery({
    ...glOptions,
    enabled: isAdding,
  });

  const githubRepos = ((githubRepoData as { repositories?: unknown[] })?.repositories ?? []) as {
    id: number;
    fullName: string;
    private: boolean;
  }[];
  const gitlabRepos = ((gitlabRepoData as { repositories?: unknown[] })?.repositories ?? []) as {
    id: number;
    fullName: string;
    private: boolean;
  }[];
  const isLoadingRepos = isLoadingGH || isLoadingGL;
  const hasMultiplePlatforms = githubRepos.length > 0 && gitlabRepos.length > 0;

  const allRepos: RepoOption[] = [
    ...githubRepos.map(r => ({ ...r, platform: 'github' as const })),
    ...gitlabRepos.map(r => ({ ...r, platform: 'gitlab' as const })),
  ];

  const profileBindings = bindings?.filter(b => b.profileId === profileId) ?? [];

  const handleBind = async () => {
    if (!selectedRepo) return;
    const [platform, fullName] = selectedRepo.split(':');
    try {
      await bind.mutateAsync({
        organizationId,
        profileId,
        repoFullName: fullName,
        platform: platform as 'github' | 'gitlab',
      });
      toast.success(`Pinned to "${fullName}"`);
      setSelectedRepo('');
      setIsAdding(false);
    } catch {
      toast.error('Failed to pin repo');
    }
  };

  if (isLoading) return null;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="h-4 w-4" />
          Pinned to repositories
        </div>
        {!isAdding && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAdding(true)}
            disabled={bind.isPending}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Pin a repo
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Auto-loaded whenever a session targets one of these repositories.
      </p>

      {/* Add binding form */}
      {isAdding && (
        <div className="flex items-center gap-2">
          <Popover open={repoPopoverOpen} onOpenChange={setRepoPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                role="combobox"
                className="flex-1 justify-between font-normal"
                disabled={isLoadingRepos}
              >
                <span className="truncate">
                  {selectedRepo ? (
                    selectedRepo.split(':')[1]
                  ) : (
                    <span className="text-muted-foreground">Select repository…</span>
                  )}
                </span>
                {isLoadingRepos ? (
                  <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ChevronDown className="text-muted-foreground ml-2 h-3.5 w-3.5 shrink-0" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
              <Command>
                <CommandInput placeholder="Search repos..." />
                <CommandEmpty>No repositories found</CommandEmpty>
                <CommandList className="max-h-48 overflow-auto">
                  {hasMultiplePlatforms ? (
                    <>
                      {githubRepos.length > 0 && (
                        <CommandGroup heading="GitHub">
                          {githubRepos.map(r => (
                            <RepoPinCommandItem
                              key={r.id}
                              repo={{ ...r, platform: 'github' }}
                              isSelected={`github:${r.fullName}` === selectedRepo}
                              onSelect={v => {
                                setSelectedRepo(v);
                                setRepoPopoverOpen(false);
                              }}
                            />
                          ))}
                        </CommandGroup>
                      )}
                      {gitlabRepos.length > 0 && (
                        <CommandGroup heading="GitLab">
                          {gitlabRepos.map(r => (
                            <RepoPinCommandItem
                              key={r.id}
                              repo={{ ...r, platform: 'gitlab' }}
                              isSelected={`gitlab:${r.fullName}` === selectedRepo}
                              onSelect={v => {
                                setSelectedRepo(v);
                                setRepoPopoverOpen(false);
                              }}
                            />
                          ))}
                        </CommandGroup>
                      )}
                    </>
                  ) : (
                    <CommandGroup>
                      {allRepos.map(r => (
                        <RepoPinCommandItem
                          key={r.id}
                          repo={r}
                          isSelected={`${r.platform}:${r.fullName}` === selectedRepo}
                          onSelect={v => {
                            setSelectedRepo(v);
                            setRepoPopoverOpen(false);
                          }}
                        />
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setIsAdding(false);
              setSelectedRepo('');
            }}
            disabled={bind.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleBind} disabled={!selectedRepo || bind.isPending}>
            {bind.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Pin'}
          </Button>
        </div>
      )}

      {profileBindings.length === 0 && !isAdding ? (
        <p className="text-muted-foreground text-xs italic">Not pinned to any repositories.</p>
      ) : profileBindings.length > 0 ? (
        <div className="space-y-1.5">
          {profileBindings.map(binding => (
            <div
              key={`${binding.repoFullName}-${binding.platform}`}
              className="bg-background flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <Link2 className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate font-mono text-xs">{binding.repoFullName}</span>
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
                {binding.platform}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
                onClick={async () => {
                  try {
                    await unbind.mutateAsync({
                      repoFullName: binding.repoFullName,
                      platform: binding.platform as 'github' | 'gitlab',
                      organizationId,
                    });
                    toast.success('Repo unbound');
                  } catch {
                    toast.error('Failed to unbind repo');
                  }
                }}
                disabled={unbind.isPending}
                title="Unbind repo"
              >
                <Link2Off className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RepoPinCommandItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: RepoOption;
  isSelected: boolean;
  onSelect: (v: string) => void;
}) {
  return (
    <CommandItem
      value={`${repo.platform}:${repo.fullName}`}
      onSelect={onSelect}
      className="flex items-center gap-2"
    >
      {repo.private ? (
        <Lock className="h-3.5 w-3.5 text-yellow-500" />
      ) : (
        <Unlock className="text-muted-foreground h-3.5 w-3.5" />
      )}
      <span className="truncate text-xs">{repo.fullName}</span>
      <Check className={cn('ml-auto h-3.5 w-3.5', isSelected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  );
}

// -------------------------------------------------------------------
// VarsTab
// -------------------------------------------------------------------

type VarsTabProps = {
  profileId: string;
  organizationId?: string;
  vars: ProfileVar[];
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
};

type DraftVar = { id: string; key: string; value: string; isSecret: boolean; showValue: boolean };

const makeDraft = (partial?: Partial<DraftVar>): DraftVar => ({
  id: crypto.randomUUID(),
  key: '',
  value: '',
  isSecret: false,
  showValue: false,
  ...partial,
});

const cleanKey = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

function VarsTab({ profileId, organizationId, vars, mutations }: VarsTabProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [drafts, setDrafts] = useState<DraftVar[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [showEditValue, setShowEditValue] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const startAdding = () => {
    setIsAdding(true);
    setDrafts([makeDraft()]);
  };

  const resetAdd = () => {
    setIsAdding(false);
    setDrafts([]);
  };

  const updateDraft = (id: string, patch: Partial<DraftVar>) => {
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  };

  const removeDraft = (id: string) => {
    setDrafts(prev => {
      const next = prev.filter(d => d.id !== id);
      return next.length === 0 ? [makeDraft()] : next;
    });
  };

  /** Handle paste into a draft row. Returns true if handled (caller should preventDefault). */
  const handleDraftPaste = (id: string, text: string): boolean => {
    const parsed = parseEnvText(text);
    if (parsed.length === 0) return false;
    setDrafts(prev => {
      const idx = prev.findIndex(d => d.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      const targetIsEmpty = target.key === '' && target.value === '';
      const newRows = parsed.map(p =>
        makeDraft({ key: p.key, value: p.value, isSecret: target.isSecret })
      );
      // Replace the current row if it's empty; otherwise insert after it.
      const before = prev.slice(0, idx);
      const after = prev.slice(idx + 1);
      if (targetIsEmpty) {
        return [...before, ...newRows, ...after];
      }
      if (parsed.length === 1) {
        // Single pair pasted into a populated field — let the browser handle it (overwrite just that field).
        return prev;
      }
      return [...before, target, ...newRows, ...after];
    });
    return true;
  };

  const handleSaveAll = async () => {
    const entries = drafts.map(d => ({ ...d, key: d.key.trim() })).filter(d => d.key !== '');
    if (entries.length === 0) {
      toast.error('Add at least one variable');
      return;
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.key)) {
        toast.error(`Duplicate key "${e.key}" in drafts`);
        return;
      }
      seen.add(e.key);
    }
    setSavingKey('__new__');
    let succeeded = 0;
    const failed: string[] = [];
    try {
      for (const entry of entries) {
        try {
          await mutations.setVar.mutateAsync({
            profileId,
            key: entry.key,
            value: entry.value,
            isSecret: entry.isSecret,
            organizationId,
          });
          succeeded += 1;
        } catch {
          failed.push(entry.key);
        }
      }
      if (failed.length === 0) {
        toast.success(
          succeeded === 1 ? `Variable "${entries[0].key}" added` : `Added ${succeeded} variables`
        );
        resetAdd();
      } else {
        toast.error(
          `Added ${succeeded} of ${entries.length}. Failed: ${failed.slice(0, 3).join(', ')}${
            failed.length > 3 ? '…' : ''
          }`
        );
      }
    } finally {
      setSavingKey(null);
    }
  };

  const handleSaveEdit = async (varItem: ProfileVar) => {
    setSavingKey(varItem.key);
    try {
      await mutations.setVar.mutateAsync({
        profileId,
        key: varItem.key,
        value: editingValue,
        isSecret: varItem.isSecret,
        organizationId,
      });
      toast.success(`Variable "${varItem.key}" updated`);
      setEditingKey(null);
    } catch {
      toast.error('Failed to update variable');
    } finally {
      setSavingKey(null);
    }
  };

  const handleDelete = async (key: string) => {
    setDeletingKey(key);
    try {
      await mutations.deleteVar.mutateAsync({ profileId, key, organizationId });
      toast.success(`Variable "${key}" deleted`);
    } catch {
      toast.error('Failed to delete variable');
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-1.5">
        <Key className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-xs font-medium">Environment Variables</span>
      </div>

      {vars.map(varItem => (
        <div
          key={varItem.key}
          className="hover:bg-accent/50 rounded-lg border p-2 transition-colors"
        >
          {editingKey === varItem.key ? (
            <div className="space-y-2">
              <code className="bg-muted rounded px-2 py-0.5 font-mono text-xs">{varItem.key}</code>
              <div className="relative">
                <Input
                  type={showEditValue ? 'text' : 'password'}
                  value={editingValue}
                  onChange={e => setEditingValue(e.target.value)}
                  placeholder={varItem.isSecret ? 'Enter new secret value' : 'Value'}
                  className="pr-10 text-sm"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-form-type="other"
                />
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                  onClick={() => setShowEditValue(!showEditValue)}
                >
                  {showEditValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingKey(null)}
                  disabled={savingKey === varItem.key}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSaveEdit(varItem)}
                  disabled={savingKey === varItem.key}
                >
                  {savingKey === varItem.key ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <code className="bg-muted shrink-0 rounded px-2 py-0.5 font-mono text-xs">
                  {varItem.key}
                </code>
                {varItem.isSecret ? (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Lock className="h-3 w-3" />
                    •••••••
                  </span>
                ) : (
                  <span className="text-muted-foreground truncate text-xs">{varItem.value}</span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => {
                    setEditingKey(varItem.key);
                    setEditingValue(varItem.isSecret ? '' : varItem.value);
                    setShowEditValue(!varItem.isSecret);
                  }}
                  disabled={deletingKey === varItem.key}
                >
                  Edit
                </Button>
                <InlineDeleteConfirmation
                  onDelete={() => handleDelete(varItem.key)}
                  isLoading={deletingKey === varItem.key}
                />
              </div>
            </div>
          )}
        </div>
      ))}

      {isAdding ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">New variables</Label>
            <p className="text-muted-foreground text-[11px]">
              Tip: paste <code className="font-mono">KEY=VALUE</code> lines to add many at once.
            </p>
          </div>

          <div className="space-y-2">
            {drafts.map((draft, idx) => (
              <div key={draft.id} className="flex items-center gap-2">
                <Input
                  value={draft.key}
                  onChange={e => updateDraft(draft.id, { key: cleanKey(e.target.value) })}
                  onPaste={e => {
                    if (handleDraftPaste(draft.id, e.clipboardData.getData('text'))) {
                      e.preventDefault();
                    }
                  }}
                  placeholder="API_KEY"
                  className="h-8 w-44 font-mono text-sm"
                  autoFocus={idx === 0}
                  disabled={savingKey === '__new__'}
                />
                <div className="relative flex-1">
                  <Input
                    type={draft.showValue || !draft.isSecret ? 'text' : 'password'}
                    value={draft.value}
                    onChange={e => updateDraft(draft.id, { value: e.target.value })}
                    onPaste={e => {
                      if (handleDraftPaste(draft.id, e.clipboardData.getData('text'))) {
                        e.preventDefault();
                      }
                    }}
                    placeholder={draft.isSecret ? 'Secret value (encrypted)' : 'Value'}
                    className="h-8 pr-8 text-sm"
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-form-type="other"
                    disabled={savingKey === '__new__'}
                  />
                  {draft.isSecret && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                      onClick={() => updateDraft(draft.id, { showValue: !draft.showValue })}
                      tabIndex={-1}
                    >
                      {draft.showValue ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => updateDraft(draft.id, { isSecret: !draft.isSecret })}
                  className={cn(
                    'hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md border',
                    draft.isSecret
                      ? 'border-primary/40 text-primary'
                      : 'text-muted-foreground border-input'
                  )}
                  title={draft.isSecret ? 'Encrypted secret' : 'Plain value — click to encrypt'}
                  disabled={savingKey === '__new__'}
                >
                  <Lock className="h-3.5 w-3.5" />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  onClick={() => removeDraft(draft.id)}
                  disabled={savingKey === '__new__'}
                  aria-label="Remove row"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDrafts(prev => [...prev, makeDraft()])}
            disabled={savingKey === '__new__'}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add another
          </Button>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={resetAdd} disabled={savingKey === '__new__'}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveAll} disabled={savingKey === '__new__'}>
              {savingKey === '__new__' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="h-11 w-full border-dashed" onClick={startAdding}>
          <Plus className="mr-2 h-4 w-4" />
          Add Variable
        </Button>
      )}

      {vars.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">No environment variables.</p>
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// .env paste parsing
// -------------------------------------------------------------------

function stripEnvQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\n])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvText(content: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eqIdx + 1).trim();
    // Drop trailing unquoted inline comments (e.g. `VAL=foo # note`)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    value = stripEnvQuotes(value);
    if (seen.has(key)) {
      const prev = out.findIndex(e => e.key === key);
      if (prev !== -1) out[prev] = { key, value };
    } else {
      seen.add(key);
      out.push({ key, value });
    }
  }
  return out;
}

// -------------------------------------------------------------------
// CommandsTab
// -------------------------------------------------------------------

type CommandsTabProps = {
  profileId: string;
  organizationId?: string;
  commands: { sequence: number; command: string }[];
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
};

function CommandsTab({ profileId, organizationId, commands, mutations }: CommandsTabProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newCommand, setNewCommand] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newCommand.trim()) {
      toast.error('Command is required');
      return;
    }
    const current = commands.map(c => c.command);
    setSaving(true);
    try {
      await mutations.setCommands.mutateAsync({
        profileId,
        commands: [...current, newCommand.trim()],
        organizationId,
      });
      toast.success('Command added');
      setIsAdding(false);
      setNewCommand('');
    } catch {
      toast.error('Failed to add command');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (index: number) => {
    const updated = commands.filter((_, i) => i !== index).map(c => c.command);
    setSaving(true);
    try {
      await mutations.setCommands.mutateAsync({ profileId, commands: updated, organizationId });
      toast.success('Command deleted');
    } catch {
      toast.error('Failed to delete command');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-1.5">
        <Terminal className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-xs font-medium">Setup Commands</span>
      </div>

      {commands.map((cmd, i) => (
        <div
          key={`${cmd.sequence}-${i}`}
          className="hover:bg-accent/50 flex items-center gap-2 rounded-lg border p-2 transition-colors"
        >
          <span className="text-muted-foreground w-5 shrink-0 text-xs">{i + 1}.</span>
          <code className="bg-muted flex-1 truncate rounded px-2 py-0.5 font-mono text-xs">
            {cmd.command}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive h-7 w-7 shrink-0"
            onClick={() => handleDelete(i)}
            disabled={saving}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      {isAdding ? (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">Command</Label>
            <Input
              value={newCommand}
              onChange={e => setNewCommand(e.target.value)}
              placeholder="npm install"
              className="font-mono text-sm"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && !saving && handleAdd()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAdding(false);
                setNewCommand('');
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleAdd} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          className="h-11 w-full border-dashed"
          onClick={() => setIsAdding(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Command
        </Button>
      )}

      {commands.length === 0 && !isAdding && (
        <p className="text-muted-foreground py-2 text-center text-sm">
          No startup commands. Commands run in order when the session starts.
        </p>
      )}
    </div>
  );
}
