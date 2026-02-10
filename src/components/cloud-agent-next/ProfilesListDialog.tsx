/** Dialog to list and manage all environment profiles with inline editing. */
'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  FolderCog,
  Star,
  Plus,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  Trash2,
  Key,
  Terminal,
  Building,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  useProfiles,
  useCombinedProfiles,
  useProfile,
  useProfileMutations,
  useCombinedProfileMutations,
  type ProfileSummaryWithOwner,
  type ProfileVar,
  type ProfileOwnerType,
} from '@/hooks/useCloudAgentProfiles';

type ProfilesListDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProfileSelect?: (profileId: string) => void;
};

export function ProfilesListDialog({
  organizationId,
  open,
  onOpenChange,
  onProfileSelect,
}: ProfilesListDialogProps) {
  // Use combined profiles when in org context
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

  // Get profiles based on context
  const orgProfiles = organizationId ? (combinedQuery.data?.orgProfiles ?? []) : [];
  const personalProfiles = organizationId
    ? (combinedQuery.data?.personalProfiles ?? [])
    : (regularQuery.data ?? []).map(p => ({ ...p, ownerType: 'user' as const }));
  const effectiveDefaultId = organizationId ? combinedQuery.data?.effectiveDefaultId : null;

  // Use combined mutations when in org context
  const combinedMutations = useCombinedProfileMutations({
    organizationId: organizationId ?? '',
  });
  const regularMutations = useProfileMutations({
    organizationId: undefined,
  });

  // State for creating new profile
  const [isCreating, setIsCreating] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDescription, setNewProfileDescription] = useState('');
  const [newProfileOwnerType, setNewProfileOwnerType] = useState<ProfileOwnerType>(
    organizationId ? 'organization' : 'user'
  );

  // State for expanded profile (accordion - only one at a time)
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(null);

  // Loading states
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingDefaultId, setTogglingDefaultId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Reset owner type when dialog opens in org context
  useEffect(() => {
    if (open && organizationId) {
      setNewProfileOwnerType('organization');
    }
  }, [open, organizationId]);

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
      if (expandedProfileId === profile.id) {
        setExpandedProfileId(null);
      }
    } catch (err) {
      console.error('Failed to delete profile:', err);
      toast.error('Failed to delete profile');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleDefault = async (profile: ProfileSummaryWithOwner) => {
    setTogglingDefaultId(profile.id);
    try {
      const profileOrgId = profile.ownerType === 'organization' ? organizationId : undefined;
      const mutations = organizationId ? combinedMutations : regularMutations;

      if (profile.isDefault) {
        await mutations.clearDefault.mutateAsync({
          profileId: profile.id,
          organizationId: profileOrgId,
        });
        toast.success(`"${profile.name}" is no longer the default`);
      } else {
        await mutations.setAsDefault.mutateAsync({
          profileId: profile.id,
          organizationId: profileOrgId,
        });
        toast.success(`"${profile.name}" is now the default profile`);
      }
    } catch (err) {
      console.error('Failed to toggle default:', err);
      toast.error('Failed to update default profile');
    } finally {
      setTogglingDefaultId(null);
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) {
      toast.error('Profile name is required');
      return;
    }

    setSavingId('new');
    try {
      // Determine which organizationId to use based on owner type selection
      const createOrgId = newProfileOwnerType === 'organization' ? organizationId : undefined;

      const mutations = organizationId ? combinedMutations : regularMutations;
      const createdProfile = await mutations.createProfile.mutateAsync({
        name: newProfileName.trim(),
        description: newProfileDescription.trim() || undefined,
        organizationId: createOrgId,
      });
      toast.success(`Profile "${newProfileName}" created`);
      setIsCreating(false);
      setNewProfileName('');
      setNewProfileDescription('');
      // Expand the newly created profile for editing
      if (createdProfile?.id) {
        setExpandedProfileId(createdProfile.id);
      }
    } catch (err) {
      console.error('Failed to create profile:', err);
      toast.error('Failed to create profile');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleExpand = (profileId: string) => {
    setExpandedProfileId(prev => (prev === profileId ? null : profileId));
  };

  const handleProfileUse = (profileId: string) => {
    if (!onProfileSelect) {
      return;
    }
    onProfileSelect(profileId);
    onOpenChange(false);
  };

  const hasNoProfiles = orgProfiles.length === 0 && personalProfiles.length === 0 && !isCreating;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[650px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderCog className="h-5 w-5" />
            Manage Profiles
          </DialogTitle>
          <DialogDescription>
            Create and manage environment profiles with variables and setup commands.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-destructive flex items-center justify-center gap-2 py-8">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load profiles</span>
            </div>
          ) : hasNoProfiles ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">No profiles yet.</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Create a profile to save environment variables and setup commands.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Organization profiles section */}
              {organizationId && orgProfiles.length > 0 && (
                <div>
                  <h4 className="text-muted-foreground mb-2 flex items-center gap-2 text-sm font-medium">
                    <Building className="h-4 w-4" />
                    Organization Profiles
                  </h4>
                  <div className="space-y-2">
                    {orgProfiles.map(profile => (
                      <ProfileRow
                        key={profile.id}
                        profile={profile}
                        organizationId={organizationId}
                        isExpanded={expandedProfileId === profile.id}
                        onToggleExpand={() => handleToggleExpand(profile.id)}
                        onDelete={() => handleDelete(profile)}
                        onToggleDefault={() => handleToggleDefault(profile)}
                        isDeleting={deletingId === profile.id}
                        isTogglingDefault={togglingDefaultId === profile.id}
                        onProfileSelect={handleProfileUse}
                        isEffectiveDefault={profile.id === effectiveDefaultId}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Personal profiles section */}
              {personalProfiles.length > 0 && (
                <div>
                  <h4 className="text-muted-foreground mb-2 flex items-center gap-2 text-sm font-medium">
                    <User className="h-4 w-4" />
                    {organizationId ? 'Personal Profiles' : 'Your Profiles'}
                  </h4>
                  <div className="space-y-2">
                    {personalProfiles.map(profile => (
                      <ProfileRow
                        key={profile.id}
                        profile={profile}
                        organizationId={
                          profile.ownerType === 'organization' ? organizationId : undefined
                        }
                        isExpanded={expandedProfileId === profile.id}
                        onToggleExpand={() => handleToggleExpand(profile.id)}
                        onDelete={() => handleDelete(profile)}
                        onToggleDefault={() => handleToggleDefault(profile)}
                        isDeleting={deletingId === profile.id}
                        isTogglingDefault={togglingDefaultId === profile.id}
                        onProfileSelect={handleProfileUse}
                        isEffectiveDefault={
                          organizationId ? profile.id === effectiveDefaultId : profile.isDefault
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Create new profile form */}
              {isCreating && (
                <div className="rounded-lg border border-dashed p-3">
                  <div className="space-y-3">
                    {/* Owner type selection (only in org context) */}
                    {organizationId && (
                      <div className="grid gap-2">
                        <Label>Profile Type</Label>
                        <RadioGroup
                          value={newProfileOwnerType}
                          onValueChange={v => setNewProfileOwnerType(v as ProfileOwnerType)}
                          className="flex gap-4"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="organization" id="owner-org" />
                            <Label
                              htmlFor="owner-org"
                              className="flex cursor-pointer items-center gap-2"
                            >
                              <Building className="h-4 w-4" />
                              Organization
                              <span className="text-muted-foreground text-xs">(shared)</span>
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="user" id="owner-user" />
                            <Label
                              htmlFor="owner-user"
                              className="flex cursor-pointer items-center gap-2"
                            >
                              <User className="h-4 w-4" />
                              Personal
                              <span className="text-muted-foreground text-xs">(only you)</span>
                            </Label>
                          </div>
                        </RadioGroup>
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="new-profile-name">Name</Label>
                      <Input
                        id="new-profile-name"
                        value={newProfileName}
                        onChange={e => setNewProfileName(e.target.value)}
                        placeholder="New profile name"
                        autoFocus={!organizationId}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="new-profile-desc">Description</Label>
                      <Textarea
                        id="new-profile-desc"
                        value={newProfileDescription}
                        onChange={e => setNewProfileDescription(e.target.value)}
                        placeholder="Optional description"
                        rows={2}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setIsCreating(false);
                          setNewProfileName('');
                          setNewProfileDescription('');
                          setNewProfileOwnerType(organizationId ? 'organization' : 'user');
                        }}
                        disabled={savingId === 'new'}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleCreateProfile} disabled={savingId === 'new'}>
                        {savingId === 'new' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          'Create'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          {!isCreating && (
            <Button variant="outline" onClick={() => setIsCreating(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Profile
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------
// ProfileRow - A single profile row that can be expanded/collapsed
// -------------------------------------------------------------------

type ProfileRowProps = {
  profile: ProfileSummaryWithOwner;
  organizationId?: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
  onToggleDefault: () => void;
  isDeleting: boolean;
  isTogglingDefault: boolean;
  onProfileSelect?: (profileId: string) => void;
  isEffectiveDefault?: boolean;
};

function ProfileRow({
  profile,
  organizationId,
  isExpanded,
  onToggleExpand,
  onDelete,
  onToggleDefault,
  isDeleting,
  isTogglingDefault,
  onProfileSelect,
  isEffectiveDefault,
}: ProfileRowProps) {
  return (
    <div className="rounded-lg border transition-colors">
      {/* Collapsed header - always visible */}
      <div
        className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 p-3"
        onClick={onToggleExpand}
      >
        <span className="text-muted-foreground shrink-0">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>

        {/* Owner type icon */}
        <span className="text-muted-foreground shrink-0">
          {profile.ownerType === 'organization' ? (
            <Building className="h-4 w-4" />
          ) : (
            <User className="h-4 w-4" />
          )}
        </span>

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{profile.name}</span>
            {isEffectiveDefault && <Star className="text-primary h-4 w-4 fill-current" />}
          </div>
          {!isExpanded && profile.description && (
            <p className="text-muted-foreground mt-0.5 line-clamp-1 text-sm">
              {profile.description}
            </p>
          )}
          {!isExpanded && (
            <p className="text-muted-foreground mt-1 text-xs">
              {profile.varCount} variables · {profile.commandCount} commands
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
          {onProfileSelect ? (
            <Button variant="ghost" size="sm" onClick={() => onProfileSelect(profile.id)}>
              Use
            </Button>
          ) : null}
          <InlineDeleteConfirmation onDelete={onDelete} isLoading={isDeleting} />
          <div
            className="ml-2 flex items-center gap-1.5 border-l pl-2"
            title={profile.isDefault ? 'Default profile' : 'Set as default'}
          >
            <Switch
              checked={profile.isDefault}
              onCheckedChange={onToggleDefault}
              disabled={isTogglingDefault}
            />
          </div>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <ProfileEditPanel
          profileId={profile.id}
          organizationId={profile.ownerType === 'organization' ? organizationId : undefined}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// ProfileEditPanel - Inline editing UI for variables and commands
// -------------------------------------------------------------------

type ProfileEditPanelProps = {
  profileId: string;
  organizationId?: string;
};

function ProfileEditPanel({ profileId, organizationId }: ProfileEditPanelProps) {
  const { data: profile, isLoading, error } = useProfile(profileId, { organizationId });
  const { setVar, deleteVar, setCommands, updateProfile } = useProfileMutations({ organizationId });

  // State for editable profile metadata
  const [profileName, setProfileName] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [savingMetadata, setSavingMetadata] = useState(false);

  // State for adding new variable
  const [isAddingVar, setIsAddingVar] = useState(false);
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');
  const [newVarIsSecret, setNewVarIsSecret] = useState(false);
  const [showNewVarValue, setShowNewVarValue] = useState(false);

  // State for editing existing variable value
  const [editingVarKey, setEditingVarKey] = useState<string | null>(null);
  const [editingVarValue, setEditingVarValue] = useState('');
  const [showEditingVarValue, setShowEditingVarValue] = useState(false);

  // State for adding new command
  const [isAddingCommand, setIsAddingCommand] = useState(false);
  const [newCommand, setNewCommand] = useState('');

  // Loading states
  const [savingVarKey, setSavingVarKey] = useState<string | null>(null);
  const [deletingVarKey, setDeletingVarKey] = useState<string | null>(null);
  const [savingCommands, setSavingCommands] = useState(false);

  // Active tab
  const [activeTab, setActiveTab] = useState<'vars' | 'commands'>('vars');

  // Sync profile metadata when loaded
  useEffect(() => {
    if (profile) {
      setProfileName(profile.name);
      setProfileDescription(profile.description || '');
    }
  }, [profile]);

  const resetNewVarForm = () => {
    setIsAddingVar(false);
    setNewVarKey('');
    setNewVarValue('');
    setNewVarIsSecret(false);
    setShowNewVarValue(false);
  };

  const resetEditVarForm = () => {
    setEditingVarKey(null);
    setEditingVarValue('');
    setShowEditingVarValue(false);
  };

  const handleSaveMetadata = async () => {
    if (!profileName.trim()) {
      toast.error('Profile name is required');
      return;
    }

    setSavingMetadata(true);
    try {
      await updateProfile.mutateAsync({
        profileId,
        name: profileName.trim(),
        description: profileDescription.trim() || undefined,
        organizationId,
      });
      toast.success('Profile updated');
    } catch (err) {
      console.error('Failed to update profile:', err);
      toast.error('Failed to update profile');
    } finally {
      setSavingMetadata(false);
    }
  };

  const handleAddVar = async () => {
    if (!newVarKey.trim()) {
      toast.error('Variable key is required');
      return;
    }
    if (!newVarValue && !newVarIsSecret) {
      toast.error('Variable value is required');
      return;
    }

    setSavingVarKey('__new__');
    try {
      await setVar.mutateAsync({
        profileId,
        key: newVarKey.trim(),
        value: newVarValue,
        isSecret: newVarIsSecret,
        organizationId,
      });
      toast.success(`Variable "${newVarKey}" added`);
      resetNewVarForm();
    } catch (err) {
      console.error('Failed to add variable:', err);
      toast.error('Failed to add variable');
    } finally {
      setSavingVarKey(null);
    }
  };

  const handleStartEditVar = (varItem: ProfileVar) => {
    setEditingVarKey(varItem.key);
    // For secrets, value is masked - user must enter new value
    setEditingVarValue(varItem.isSecret ? '' : varItem.value);
    setShowEditingVarValue(!varItem.isSecret);
  };

  const handleSaveVar = async (varItem: ProfileVar) => {
    if (!editingVarValue && varItem.isSecret) {
      // For secrets, if no new value entered, cancel edit
      resetEditVarForm();
      return;
    }

    setSavingVarKey(varItem.key);
    try {
      await setVar.mutateAsync({
        profileId,
        key: varItem.key,
        value: editingVarValue,
        isSecret: varItem.isSecret,
        organizationId,
      });
      toast.success(`Variable "${varItem.key}" updated`);
      resetEditVarForm();
    } catch (err) {
      console.error('Failed to update variable:', err);
      toast.error('Failed to update variable');
    } finally {
      setSavingVarKey(null);
    }
  };

  const handleDeleteVar = async (key: string) => {
    setDeletingVarKey(key);
    try {
      await deleteVar.mutateAsync({ profileId, key, organizationId });
      toast.success(`Variable "${key}" deleted`);
    } catch (err) {
      console.error('Failed to delete variable:', err);
      toast.error('Failed to delete variable');
    } finally {
      setDeletingVarKey(null);
    }
  };

  const handleAddCommand = async () => {
    if (!newCommand.trim()) {
      toast.error('Command is required');
      return;
    }

    const currentCommands = profile?.commands.map(c => c.command) || [];
    const updatedCommands = [...currentCommands, newCommand.trim()];

    setSavingCommands(true);
    try {
      await setCommands.mutateAsync({
        profileId,
        commands: updatedCommands,
        organizationId,
      });
      toast.success('Command added');
      setIsAddingCommand(false);
      setNewCommand('');
    } catch (err) {
      console.error('Failed to add command:', err);
      toast.error('Failed to add command');
    } finally {
      setSavingCommands(false);
    }
  };

  const handleDeleteCommand = async (index: number) => {
    const currentCommands = profile?.commands.map(c => c.command) || [];
    const updatedCommands = currentCommands.filter((_, i) => i !== index);

    setSavingCommands(true);
    try {
      await setCommands.mutateAsync({
        profileId,
        commands: updatedCommands,
        organizationId,
      });
      toast.success('Command deleted');
    } catch (err) {
      console.error('Failed to delete command:', err);
      toast.error('Failed to delete command');
    } finally {
      setSavingCommands(false);
    }
  };

  if (isLoading) {
    return (
      <div className="border-t px-3 py-4">
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-t px-3 py-4">
        <div className="text-destructive flex items-center justify-center gap-2 py-4">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">Failed to load profile details</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t px-3 py-3">
      {/* Editable name and description */}
      <div className="space-y-3 border-b pb-3">
        <div className="grid gap-2">
          <Label htmlFor={`profile-name-${profileId}`}>Name</Label>
          <Input
            id={`profile-name-${profileId}`}
            value={profileName}
            onChange={e => setProfileName(e.target.value)}
            placeholder="Profile name"
            disabled={savingMetadata}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`profile-description-${profileId}`}>Description</Label>
          <Textarea
            id={`profile-description-${profileId}`}
            value={profileDescription}
            onChange={e => setProfileDescription(e.target.value)}
            placeholder="Optional description"
            rows={2}
            disabled={savingMetadata}
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleSaveMetadata}
            disabled={
              savingMetadata ||
              (profileName === profile?.name && profileDescription === (profile?.description || ''))
            }
          >
            {savingMetadata ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b">
        <button
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === 'vars'
              ? 'border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent'
          }`}
          onClick={() => setActiveTab('vars')}
        >
          <Key className="mr-1.5 inline-block h-4 w-4" />
          Variables ({profile?.vars.length || 0})
        </button>
        <button
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === 'commands'
              ? 'border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent'
          }`}
          onClick={() => setActiveTab('commands')}
        >
          <Terminal className="mr-1.5 inline-block h-4 w-4" />
          Commands ({profile?.commands.length || 0})
        </button>
      </div>

      {/* Tab content */}
      <div className="py-2">
        {activeTab === 'vars' ? (
          /* Variables Tab */
          <div className="space-y-2">
            {profile?.vars.map(varItem => (
              <div
                key={varItem.key}
                className="hover:bg-accent/50 rounded-lg border p-2 transition-colors"
              >
                {editingVarKey === varItem.key ? (
                  // Edit mode
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <code className="bg-muted rounded px-2 py-1 font-mono text-sm">
                        {varItem.key}
                      </code>
                      {varItem.isSecret && <Lock className="text-muted-foreground h-4 w-4" />}
                    </div>
                    <div className="relative">
                      <Input
                        type={showEditingVarValue ? 'text' : 'password'}
                        value={editingVarValue}
                        onChange={e => setEditingVarValue(e.target.value)}
                        placeholder={varItem.isSecret ? 'Enter new secret value' : 'Value'}
                        className="pr-10"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-1p-ignore="true"
                        data-lpignore="true"
                        data-form-type="other"
                      />
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                        onClick={() => setShowEditingVarValue(!showEditingVarValue)}
                      >
                        {showEditingVarValue ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={resetEditVarForm}
                        disabled={savingVarKey === varItem.key}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleSaveVar(varItem)}
                        disabled={savingVarKey === varItem.key}
                      >
                        {savingVarKey === varItem.key ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          'Save'
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  // View mode
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <code className="bg-muted shrink-0 rounded px-2 py-1 font-mono text-sm">
                        {varItem.key}
                      </code>
                      {varItem.isSecret ? (
                        <span className="text-muted-foreground flex items-center gap-1 text-sm">
                          <Lock className="h-3 w-3" />
                          •••••••
                        </span>
                      ) : (
                        <span className="text-muted-foreground truncate text-sm">
                          {varItem.value}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStartEditVar(varItem)}
                        disabled={deletingVarKey === varItem.key}
                      >
                        Edit
                      </Button>
                      <InlineDeleteConfirmation
                        onDelete={() => handleDeleteVar(varItem.key)}
                        isLoading={deletingVarKey === varItem.key}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add new variable form */}
            {isAddingVar ? (
              <div className="space-y-3 rounded-lg border border-dashed p-2">
                <div className="grid gap-2">
                  <Label htmlFor={`new-var-key-${profileId}`}>Variable Name</Label>
                  <Input
                    id={`new-var-key-${profileId}`}
                    value={newVarKey}
                    onChange={e =>
                      setNewVarKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))
                    }
                    placeholder="API_KEY"
                    className="font-mono"
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`new-var-value-${profileId}`}>Value</Label>
                  <div className="relative">
                    <Input
                      id={`new-var-value-${profileId}`}
                      type={showNewVarValue ? 'text' : 'password'}
                      value={newVarValue}
                      onChange={e => setNewVarValue(e.target.value)}
                      placeholder={newVarIsSecret ? 'Secret value (encrypted)' : 'Value'}
                      className="pr-10"
                      autoComplete="new-password"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                    />
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
                      onClick={() => setShowNewVarValue(!showNewVarValue)}
                    >
                      {showNewVarValue ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`new-var-secret-${profileId}`}
                    checked={newVarIsSecret}
                    onCheckedChange={checked => setNewVarIsSecret(checked === true)}
                  />
                  <Label
                    htmlFor={`new-var-secret-${profileId}`}
                    className="flex cursor-pointer items-center gap-1"
                  >
                    <Lock className="h-3 w-3" />
                    Store as encrypted secret
                  </Label>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={resetNewVarForm}
                    disabled={savingVarKey === '__new__'}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleAddVar} disabled={savingVarKey === '__new__'}>
                    {savingVarKey === '__new__' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Add Variable'
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={() => setIsAddingVar(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Variable
              </Button>
            )}

            {profile?.vars.length === 0 && !isAddingVar && (
              <p className="text-muted-foreground py-2 text-center text-sm">
                No environment variables yet.
              </p>
            )}
          </div>
        ) : (
          /* Commands Tab */
          <div className="space-y-2">
            {profile?.commands.map((cmd, index) => (
              <div
                key={`${cmd.sequence}-${index}`}
                className="hover:bg-accent/50 flex items-center gap-2 rounded-lg border p-2 transition-colors"
              >
                <span className="text-muted-foreground w-5 shrink-0 text-xs">{index + 1}.</span>
                <code className="bg-muted flex-1 truncate rounded px-2 py-1 font-mono text-sm">
                  {cmd.command}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive h-7 w-7 shrink-0"
                  onClick={() => handleDeleteCommand(index)}
                  disabled={savingCommands}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            {/* Add new command form */}
            {isAddingCommand ? (
              <div className="space-y-3 rounded-lg border border-dashed p-2">
                <div className="grid gap-2">
                  <Label htmlFor={`new-command-${profileId}`}>Command</Label>
                  <Input
                    id={`new-command-${profileId}`}
                    value={newCommand}
                    onChange={e => setNewCommand(e.target.value)}
                    placeholder="npm install"
                    className="font-mono"
                    autoFocus
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsAddingCommand(false);
                      setNewCommand('');
                    }}
                    disabled={savingCommands}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleAddCommand} disabled={savingCommands}>
                    {savingCommands ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add Command'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={() => setIsAddingCommand(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Command
              </Button>
            )}

            {profile?.commands.length === 0 && !isAddingCommand && (
              <p className="text-muted-foreground py-2 text-center text-sm">
                No startup commands yet. Commands run in order when the session starts.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
