import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  FolderCog,
  Star,
  Trash2,
  Pencil,
  ChevronRight,
  Plus,
  Loader2,
  AlertCircle,
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
import type { ProfileSummary } from '@/hooks/useCloudAgentProfiles';
import { mockProfiles } from '../../src/mockData/profiles';

/**
 * ProfilesListDialogPresentation - A presentation-only version of ProfilesListDialog
 * for Storybook stories. The actual component uses useProfiles() and useProfileMutations()
 * hooks internally, so we recreate the UI with all state passed as props.
 */
type ProfilesListDialogPresentationProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ProfileSummary[];
  isLoading?: boolean;
  error?: boolean;
  editingProfileId: string | null;
  editingName: string;
  editingDescription: string;
  onStartEdit: (profile: ProfileSummary) => void;
  onCancelEdit: () => void;
  onSaveEdit: (profileId: string) => void;
  onEditNameChange: (name: string) => void;
  onEditDescriptionChange: (description: string) => void;
  isCreating: boolean;
  newProfileName: string;
  newProfileDescription: string;
  onNewProfileNameChange: (name: string) => void;
  onNewProfileDescriptionChange: (description: string) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreateProfile: () => void;
  onDelete: (profile: ProfileSummary) => void;
  onToggleDefault: (profile: ProfileSummary) => void;
  onViewProfile: (profileId: string) => void;
  onSelectProfile?: (profileId: string) => void;
  deletingId: string | null;
  togglingDefaultId: string | null;
  savingId: string | null;
};

function ProfilesListDialogPresentation({
  open,
  onOpenChange,
  profiles,
  isLoading = false,
  error = false,
  editingProfileId,
  editingName,
  editingDescription,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditNameChange,
  onEditDescriptionChange,
  isCreating,
  newProfileName,
  newProfileDescription,
  onNewProfileNameChange,
  onNewProfileDescriptionChange,
  onStartCreate,
  onCancelCreate,
  onCreateProfile,
  onDelete,
  onToggleDefault,
  onViewProfile,
  deletingId,
  togglingDefaultId,
  savingId,
}: ProfilesListDialogPresentationProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderCog className="h-5 w-5" />
            Manage Profiles
          </DialogTitle>
          <DialogDescription>
            Create and manage environment profiles with variables and setup commands.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[400px] overflow-y-auto py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="text-destructive flex items-center justify-center gap-2 py-8">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load profiles</span>
            </div>
          ) : profiles.length === 0 && !isCreating ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">No profiles yet.</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Create a profile to save environment variables and setup commands.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {profiles.map(profile => (
                <div
                  key={profile.id}
                  className="hover:bg-accent/50 rounded-lg border p-3 transition-colors"
                >
                  {editingProfileId === profile.id ? (
                    // Edit mode
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label htmlFor={`edit-name-${profile.id}`}>Name</Label>
                        <Input
                          id={`edit-name-${profile.id}`}
                          value={editingName}
                          onChange={e => onEditNameChange(e.target.value)}
                          placeholder="Profile name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`edit-desc-${profile.id}`}>Description</Label>
                        <Textarea
                          id={`edit-desc-${profile.id}`}
                          value={editingDescription}
                          onChange={e => onEditDescriptionChange(e.target.value)}
                          placeholder="Optional description"
                          rows={2}
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={onCancelEdit}
                          disabled={savingId === profile.id}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => onSaveEdit(profile.id)}
                          disabled={savingId === profile.id}
                        >
                          {savingId === profile.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            'Save'
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // View mode
                    <div className="flex items-start justify-between gap-3">
                      <div
                        className="flex-1 cursor-pointer"
                        onClick={() => onViewProfile(profile.id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{profile.name}</span>
                          {profile.isDefault && (
                            <Star className="text-primary h-4 w-4 fill-current" />
                          )}
                        </div>
                        {profile.description && (
                          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-sm">
                            {profile.description}
                          </p>
                        )}
                        <p className="text-muted-foreground mt-1 text-xs">
                          {profile.varCount} variables · {profile.commandCount} commands
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onStartEdit(profile)}
                          disabled={deletingId === profile.id}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive h-8 w-8"
                          onClick={() => onDelete(profile)}
                          disabled={deletingId === profile.id}
                        >
                          {deletingId === profile.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                        <div
                          className="ml-2 flex items-center gap-1.5 border-l pl-2"
                          title={profile.isDefault ? 'Default profile' : 'Set as default'}
                        >
                          <Switch
                            checked={profile.isDefault}
                            onCheckedChange={() => onToggleDefault(profile)}
                            disabled={togglingDefaultId === profile.id}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onViewProfile(profile.id)}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Create new profile form */}
              {isCreating && (
                <div className="rounded-lg border border-dashed p-3">
                  <div className="space-y-3">
                    <div className="grid gap-2">
                      <Label htmlFor="new-profile-name">Name</Label>
                      <Input
                        id="new-profile-name"
                        value={newProfileName}
                        onChange={e => onNewProfileNameChange(e.target.value)}
                        placeholder="New profile name"
                        autoFocus
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="new-profile-desc">Description</Label>
                      <Textarea
                        id="new-profile-desc"
                        value={newProfileDescription}
                        onChange={e => onNewProfileDescriptionChange(e.target.value)}
                        placeholder="Optional description"
                        rows={2}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onCancelCreate}
                        disabled={savingId === 'new'}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" onClick={onCreateProfile} disabled={savingId === 'new'}>
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
            <Button variant="outline" onClick={onStartCreate}>
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

// Wrapper component to handle state
function ProfilesListDialogWrapper({
  profiles = mockProfiles,
  isLoading = false,
  error = false,
  initialEditingId = null,
  initialIsCreating = false,
}: {
  profiles?: ProfileSummary[];
  isLoading?: boolean;
  error?: boolean;
  initialEditingId?: string | null;
  initialIsCreating?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(initialEditingId);
  const [editingName, setEditingName] = useState('');
  const [editingDescription, setEditingDescription] = useState('');
  const [isCreating, setIsCreating] = useState(initialIsCreating);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDescription, setNewProfileDescription] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingDefaultId, setTogglingDefaultId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const handleStartEdit = (profile: ProfileSummary) => {
    setEditingProfileId(profile.id);
    setEditingName(profile.name);
    setEditingDescription(profile.description || '');
  };

  return (
    <ProfilesListDialogPresentation
      open={open}
      onOpenChange={setOpen}
      profiles={profiles}
      isLoading={isLoading}
      error={error}
      editingProfileId={editingProfileId}
      editingName={editingName}
      editingDescription={editingDescription}
      onStartEdit={handleStartEdit}
      onCancelEdit={() => setEditingProfileId(null)}
      onSaveEdit={profileId => console.log('Save edit:', profileId)}
      onEditNameChange={setEditingName}
      onEditDescriptionChange={setEditingDescription}
      isCreating={isCreating}
      newProfileName={newProfileName}
      newProfileDescription={newProfileDescription}
      onNewProfileNameChange={setNewProfileName}
      onNewProfileDescriptionChange={setNewProfileDescription}
      onStartCreate={() => setIsCreating(true)}
      onCancelCreate={() => {
        setIsCreating(false);
        setNewProfileName('');
        setNewProfileDescription('');
      }}
      onCreateProfile={() => console.log('Create profile')}
      onDelete={profile => console.log('Delete:', profile.name)}
      onToggleDefault={profile => console.log('Toggle default:', profile.name)}
      onViewProfile={profileId => console.log('View profile:', profileId)}
      deletingId={deletingId}
      togglingDefaultId={togglingDefaultId}
      savingId={savingId}
    />
  );
}

const meta: Meta<typeof ProfilesListDialogPresentation> = {
  title: 'Cloud Agent/ProfilesListDialog',
  component: ProfilesListDialogPresentation,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Empty state - no profiles exist yet
 */
export const Empty: Story = {
  render: () => <ProfilesListDialogWrapper profiles={[]} />,
};

/**
 * Default view with profiles
 */
export const WithProfiles: Story = {
  render: () => <ProfilesListDialogWrapper />,
};

/**
 * Loading state
 */
export const Loading: Story = {
  render: () => <ProfilesListDialogWrapper isLoading />,
};

/**
 * Error state
 */
export const Error: Story = {
  render: () => <ProfilesListDialogWrapper error />,
};

/**
 * Edit mode - editing a profile's name and description
 */
export const EditMode: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [editingName, setEditingName] = useState('AWS Production');
    const [editingDescription, setEditingDescription] = useState(
      'Production environment with AWS credentials'
    );

    return (
      <ProfilesListDialogPresentation
        open={open}
        onOpenChange={setOpen}
        profiles={mockProfiles}
        editingProfileId="profile-1"
        editingName={editingName}
        editingDescription={editingDescription}
        onStartEdit={() => {}}
        onCancelEdit={() => console.log('Cancel edit')}
        onSaveEdit={() => console.log('Save edit')}
        onEditNameChange={setEditingName}
        onEditDescriptionChange={setEditingDescription}
        isCreating={false}
        newProfileName=""
        newProfileDescription=""
        onNewProfileNameChange={() => {}}
        onNewProfileDescriptionChange={() => {}}
        onStartCreate={() => {}}
        onCancelCreate={() => {}}
        onCreateProfile={() => {}}
        onDelete={() => {}}
        onToggleDefault={() => {}}
        onViewProfile={() => {}}
        deletingId={null}
        togglingDefaultId={null}
        savingId={null}
      />
    );
  },
};

/**
 * Create new profile form visible
 */
export const CreateNew: Story = {
  render: () => <ProfilesListDialogWrapper initialIsCreating />,
};

/**
 * Deleting a profile (loading state on delete button)
 */
export const Deleting: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfilesListDialogPresentation
        open={open}
        onOpenChange={setOpen}
        profiles={mockProfiles}
        editingProfileId={null}
        editingName=""
        editingDescription=""
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSaveEdit={() => {}}
        onEditNameChange={() => {}}
        onEditDescriptionChange={() => {}}
        isCreating={false}
        newProfileName=""
        newProfileDescription=""
        onNewProfileNameChange={() => {}}
        onNewProfileDescriptionChange={() => {}}
        onStartCreate={() => {}}
        onCancelCreate={() => {}}
        onCreateProfile={() => {}}
        onDelete={() => {}}
        onToggleDefault={() => {}}
        onViewProfile={() => {}}
        deletingId="profile-2"
        togglingDefaultId={null}
        savingId={null}
      />
    );
  },
};

/**
 * Toggling default profile status
 */
export const TogglingDefault: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfilesListDialogPresentation
        open={open}
        onOpenChange={setOpen}
        profiles={mockProfiles}
        editingProfileId={null}
        editingName=""
        editingDescription=""
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSaveEdit={() => {}}
        onEditNameChange={() => {}}
        onEditDescriptionChange={() => {}}
        isCreating={false}
        newProfileName=""
        newProfileDescription=""
        onNewProfileNameChange={() => {}}
        onNewProfileDescriptionChange={() => {}}
        onStartCreate={() => {}}
        onCancelCreate={() => {}}
        onCreateProfile={() => {}}
        onDelete={() => {}}
        onToggleDefault={() => {}}
        onViewProfile={() => {}}
        deletingId={null}
        togglingDefaultId="profile-3"
        savingId={null}
      />
    );
  },
};

/**
 * Saving a profile edit
 */
export const SavingEdit: Story = {
  render: () => {
    const [open, setOpen] = useState(true);

    return (
      <ProfilesListDialogPresentation
        open={open}
        onOpenChange={setOpen}
        profiles={mockProfiles}
        editingProfileId="profile-1"
        editingName="AWS Production Updated"
        editingDescription="Updated description"
        onStartEdit={() => {}}
        onCancelEdit={() => {}}
        onSaveEdit={() => {}}
        onEditNameChange={() => {}}
        onEditDescriptionChange={() => {}}
        isCreating={false}
        newProfileName=""
        newProfileDescription=""
        onNewProfileNameChange={() => {}}
        onNewProfileDescriptionChange={() => {}}
        onStartCreate={() => {}}
        onCancelCreate={() => {}}
        onCreateProfile={() => {}}
        onDelete={() => {}}
        onToggleDefault={() => {}}
        onViewProfile={() => {}}
        deletingId={null}
        togglingDefaultId={null}
        savingId="profile-1"
      />
    );
  },
};

/**
 * Single profile in the list
 */
export const SingleProfile: Story = {
  render: () => <ProfilesListDialogWrapper profiles={[mockProfiles[0]]} />,
};

/**
 * Many profiles - shows scrolling
 */
export const ManyProfiles: Story = {
  render: () => {
    const manyProfiles: ProfileSummary[] = Array.from({ length: 12 }, (_, i) => ({
      id: `profile-${i + 1}`,
      name: `Profile ${i + 1}`,
      description: i % 2 === 0 ? `Description for profile ${i + 1}` : null,
      isDefault: i === 0,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      varCount: Math.floor(Math.random() * 10),
      commandCount: Math.floor(Math.random() * 5),
    }));
    return <ProfilesListDialogWrapper profiles={manyProfiles} />;
  },
};
