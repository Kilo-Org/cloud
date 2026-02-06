/** Dropdown to select an environment profile with default indicator. */
'use client';

import { useState } from 'react';
import { FolderCog, Star, Settings, AlertCircle, Loader2, Building, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useProfiles,
  useCombinedProfiles,
  type ProfileSummaryWithOwner,
} from '@/hooks/useCloudAgentProfiles';
import { ProfilesListDialog } from './ProfilesListDialog';

type ProfileSelectorProps = {
  organizationId?: string;
  selectedProfileId: string | null;
  onProfileSelect: (profileId: string | null) => void;
  onProfileApplied?: (profile: ProfileSummaryWithOwner) => void;
  disabled?: boolean;
  /**
   * When true and in org context, only show organization profiles (hide personal profiles).
   * Use this for features that don't support personal profiles in org context (e.g., webhook triggers).
   */
  orgProfilesOnly?: boolean;
};

export function ProfileSelector({
  organizationId,
  selectedProfileId,
  onProfileSelect,
  onProfileApplied,
  disabled = false,
  orgProfilesOnly = false,
}: ProfileSelectorProps) {
  const [showManageDialog, setShowManageDialog] = useState(false);

  // Use combined profiles when in org context, otherwise use regular profiles
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

  // Get profiles based on context
  const orgProfiles = organizationId ? (combinedQuery.data?.orgProfiles ?? []) : [];
  // Hide personal profiles in org context when orgProfilesOnly is true
  const personalProfiles = organizationId
    ? orgProfilesOnly
      ? []
      : (combinedQuery.data?.personalProfiles ?? [])
    : (regularQuery.data ?? []).map(p => ({ ...p, ownerType: 'user' as const }));
  const effectiveDefaultId = organizationId ? combinedQuery.data?.effectiveDefaultId : null;
  const allProfiles = [...orgProfiles, ...personalProfiles];

  const selectedProfile = allProfiles.find(p => p.id === selectedProfileId);

  const handleValueChange = (value: string) => {
    if (value === '__manage__') {
      setShowManageDialog(true);
      return;
    }
    if (value === '__none__') {
      onProfileSelect(null);
      return;
    }
    onProfileSelect(value);
    const profile = allProfiles.find(p => p.id === value);
    if (profile && onProfileApplied) {
      onProfileApplied(profile);
    }
  };

  if (error) {
    return (
      <Button variant="outline" size="sm" disabled className="text-destructive">
        <AlertCircle className="mr-2 h-4 w-4" />
        Failed to load profiles
      </Button>
    );
  }

  // Render profile item with owner icon
  const renderProfileItem = (profile: ProfileSummaryWithOwner, isEffectiveDefault: boolean) => (
    <SelectItem key={profile.id} value={profile.id}>
      <div className="flex items-center gap-2">
        {profile.ownerType === 'organization' ? (
          <Building className="text-muted-foreground h-3 w-3 shrink-0" />
        ) : (
          <User className="text-muted-foreground h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{profile.name}</span>
        {isEffectiveDefault && <Star className="text-primary h-3 w-3 shrink-0 fill-current" />}
        {(profile.varCount > 0 || profile.commandCount > 0) && (
          <span className="text-muted-foreground shrink-0 text-xs">
            ({profile.varCount} vars, {profile.commandCount} cmds)
          </span>
        )}
      </div>
    </SelectItem>
  );

  return (
    <>
      <Select
        value={selectedProfileId || '__none__'}
        onValueChange={handleValueChange}
        disabled={disabled || isLoading}
      >
        <SelectTrigger className="w-[200px]" size="sm">
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading...</span>
            </div>
          ) : (
            <SelectValue placeholder="No profile">
              <div className="flex items-center gap-2">
                {selectedProfile ? (
                  <>
                    {selectedProfile.ownerType === 'organization' ? (
                      <Building className="h-4 w-4 shrink-0" />
                    ) : (
                      <User className="h-4 w-4 shrink-0" />
                    )}
                    <span className="flex items-center gap-1 truncate">
                      {selectedProfile.name}
                      {selectedProfileId === effectiveDefaultId && (
                        <Star className="text-primary h-3 w-3 shrink-0 fill-current" />
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <FolderCog className="h-4 w-4 shrink-0" />
                    <span>No profile</span>
                  </>
                )}
              </div>
            </SelectValue>
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            <span className="text-muted-foreground">No profile</span>
          </SelectItem>

          {/* Org profiles section (only in org context) */}
          {organizationId && orgProfiles.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Organization Profiles</SelectLabel>
                {orgProfiles.map(profile =>
                  renderProfileItem(profile, profile.id === effectiveDefaultId)
                )}
              </SelectGroup>
            </>
          )}

          {/* Personal profiles section */}
          {personalProfiles.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{organizationId ? 'Personal Profiles' : 'Your Profiles'}</SelectLabel>
                {personalProfiles.map(profile =>
                  renderProfileItem(
                    profile,
                    organizationId ? profile.id === effectiveDefaultId : profile.isDefault
                  )
                )}
              </SelectGroup>
            </>
          )}

          <SelectSeparator />
          <SelectItem value="__manage__">
            <div className="flex items-center gap-2 font-medium">
              <Settings className="h-4 w-4" />
              Manage profiles...
            </div>
          </SelectItem>
        </SelectContent>
      </Select>

      <ProfilesListDialog
        organizationId={organizationId}
        open={showManageDialog}
        onOpenChange={setShowManageDialog}
        onProfileSelect={profileId => {
          onProfileSelect(profileId);
          setShowManageDialog(false);
        }}
      />
    </>
  );
}
