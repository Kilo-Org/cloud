'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Star, Plus, Loader2, AlertCircle, Building, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useCloudAgentSettings } from '@/hooks/useCloudAgentSettings';
import {
  useProfiles,
  useCombinedProfiles,
  useProfileMutations,
  useCombinedProfileMutations,
  type ProfileSummaryWithOwner,
} from '@/hooks/useCloudAgentProfiles';
import { ProfileDetailPane } from './ProfileDetailPane';

type ProfilesManagerProps = {
  organizationId?: string;
  onProfileSelect?: (profileId: string) => void;
  openToNewProfile?: boolean;
  /** If provided, the dialog opens with this profile pre-selected for editing. */
  initialSelectedProfileId?: string | null;
};

export function ProfilesManager({
  organizationId,
  onProfileSelect,
  openToNewProfile,
  initialSelectedProfileId,
}: ProfilesManagerProps) {
  const permissionsQuery = useCloudAgentSettings({
    organizationId,
    enabled: !!organizationId,
  });
  const canCreateOrganizationProfile =
    !!organizationId && permissionsQuery.data?.canManage === true && !permissionsQuery.error;
  const organizationPermissionMessage = permissionsQuery.error
    ? 'Could not check organization permissions.'
    : permissionsQuery.data?.canManage === false
      ? 'Only organization owners and admins can create organization profiles.'
      : !canCreateOrganizationProfile
        ? 'Checking organization permissions...'
        : undefined;
  const combinedQuery = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const regularQuery = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
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

  const [selectedId, setSelectedId] = useState<string | null>(
    openToNewProfile ? null : (initialSelectedProfileId ?? null)
  );
  const [isCreating, setIsCreating] = useState(openToNewProfile ?? false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDescription, setNewProfileDescription] = useState('');
  const [newProfileOwnerType, setNewProfileOwnerType] = useState<'personal' | 'organization'>(
    'personal'
  );
  const [savingNew, setSavingNew] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
    if (newProfileOwnerType === 'organization' && !canCreateOrganizationProfile) {
      toast.error(organizationPermissionMessage);
      return;
    }
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
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Left panel — profile list */}
      <div className="flex max-h-40 shrink-0 flex-col border-b md:max-h-none md:w-64 md:border-r md:border-b-0 lg:w-72">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
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
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {isCreating ? (
          <NewProfilePane
            organizationId={organizationId}
            canCreateOrganizationProfile={canCreateOrganizationProfile}
            organizationPermissionMessage={organizationPermissionMessage}
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
            key={selectedId}
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
    <button
      type="button"
      aria-pressed={isSelected}
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
        isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent/50 text-muted-foreground'
      )}
      onClick={onSelect}
    >
      {profile.ownerType === 'organization' ? (
        <Building className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <User className="h-3.5 w-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1 text-sm',
            isSelected && 'font-medium'
          )}
        >
          <span className="truncate" title={profile.name}>
            {profile.name}
          </span>
          {isEffectiveDefault && <Star className="text-primary h-3 w-3 shrink-0 fill-current" />}
        </div>
        <div className="text-muted-foreground shrink-0 whitespace-nowrap text-[10px]">
          {[
            profile.varCount > 0 && `${profile.varCount}v`,
            profile.mcpServerCount > 0 && `${profile.mcpServerCount}m`,
            profile.skillCount > 0 && `${profile.skillCount}s`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </button>
  );
}

// -------------------------------------------------------------------
// NewProfilePane
// -------------------------------------------------------------------

type NewProfilePaneProps = {
  organizationId?: string;
  canCreateOrganizationProfile: boolean;
  organizationPermissionMessage?: string;
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
  canCreateOrganizationProfile,
  organizationPermissionMessage,
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
  const isCreationBlocked = ownerType === 'organization' && !canCreateOrganizationProfile;
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
                  'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  ownerType === value
                    ? 'border-primary bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
                onClick={() => onOwnerTypeChange(value)}
                disabled={isSaving || (value === 'organization' && !canCreateOrganizationProfile)}
                aria-pressed={ownerType === value}
                aria-describedby={
                  value === 'organization' && !canCreateOrganizationProfile
                    ? 'organization-profile-permission'
                    : undefined
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {organizationPermissionMessage && (
            <p id="organization-profile-permission" className="text-muted-foreground text-xs">
              {organizationPermissionMessage}
            </p>
          )}
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
        <Button size="sm" onClick={onSave} disabled={isSaving || isCreationBlocked || !name.trim()}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
        </Button>
      </div>
    </div>
  );
}
