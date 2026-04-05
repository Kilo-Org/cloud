import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { FolderCog, Star, Settings, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ProfileSummary } from '@/hooks/useCloudAgentProfiles';
import { mockProfiles } from '../../src/mockData/profiles';

/**
 * ProfileSelectorPresentation - A presentation-only version of ProfileSelector
 * for Storybook stories. The actual component uses useProfiles() hook internally,
 * so we recreate the UI with mock data passed as props.
 */
type ProfileSelectorPresentationProps = {
  profiles?: ProfileSummary[];
  selectedProfileId: string | null;
  onProfileSelect: (profileId: string | null) => void;
  onManageClick?: () => void;
  onProfileApplied?: (profile: ProfileSummary) => void;
  disabled?: boolean;
  isLoading?: boolean;
  error?: boolean;
};

function ProfileSelectorPresentation({
  profiles = [],
  selectedProfileId,
  onProfileSelect,
  onManageClick,
  onProfileApplied,
  disabled = false,
  isLoading = false,
  error = false,
}: ProfileSelectorPresentationProps) {
  const selectedProfile = profiles?.find(p => p.id === selectedProfileId);

  const handleValueChange = (value: string) => {
    if (value === '__manage__') {
      onManageClick?.();
      return;
    }
    if (value === '__none__') {
      onProfileSelect(null);
      return;
    }
    onProfileSelect(value);
    const profile = profiles?.find(p => p.id === value);
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

  return (
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
              <FolderCog className="h-4 w-4" />
              {selectedProfile ? (
                <span className="flex items-center gap-1">
                  {selectedProfile.name}
                  {selectedProfile.isDefault && (
                    <Star className="text-primary h-3 w-3 fill-current" />
                  )}
                </span>
              ) : (
                'No profile'
              )}
            </div>
          </SelectValue>
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">
          <span className="text-muted-foreground">No profile</span>
        </SelectItem>

        {profiles?.map(profile => (
          <SelectItem key={profile.id} value={profile.id}>
            <div className="flex items-center gap-2">
              <span>{profile.name}</span>
              {profile.isDefault && <Star className="text-primary h-3 w-3 fill-current" />}
              {(profile.varCount > 0 || profile.commandCount > 0) && (
                <span className="text-muted-foreground text-xs">
                  ({profile.varCount} vars, {profile.commandCount} cmds)
                </span>
              )}
            </div>
          </SelectItem>
        ))}

        <SelectItem value="__manage__">
          <div className="flex items-center gap-2 font-medium">
            <Settings className="h-4 w-4" />
            Manage profiles...
          </div>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

// Wrapper component to handle state
function ProfileSelectorWrapper({
  profiles = mockProfiles,
  initialSelectedId = null,
  isLoading = false,
  error = false,
  disabled = false,
}: {
  profiles?: ProfileSummary[];
  initialSelectedId?: string | null;
  isLoading?: boolean;
  error?: boolean;
  disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);

  return (
    <ProfileSelectorPresentation
      profiles={profiles}
      selectedProfileId={selectedId}
      onProfileSelect={setSelectedId}
      onManageClick={() => console.log('Manage profiles clicked')}
      onProfileApplied={profile => console.log('Profile applied:', profile)}
      isLoading={isLoading}
      error={error}
      disabled={disabled}
    />
  );
}

const meta: Meta<typeof ProfileSelectorPresentation> = {
  title: 'Cloud Agent/ProfileSelector',
  component: ProfileSelectorPresentation,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state with profiles available but none selected
 */
export const Default: Story = {
  render: () => <ProfileSelectorWrapper />,
};

/**
 * With a profile selected (showing selected profile in trigger)
 */
export const WithSelection: Story = {
  render: () => <ProfileSelectorWrapper initialSelectedId="profile-1" />,
};

/**
 * Profile selected that is marked as default (shows star icon)
 */
export const WithDefaultSelected: Story = {
  render: () => <ProfileSelectorWrapper initialSelectedId="profile-1" />,
};

/**
 * Profile selected that is NOT the default
 */
export const WithNonDefaultSelected: Story = {
  render: () => <ProfileSelectorWrapper initialSelectedId="profile-2" />,
};

/**
 * Empty state - no profiles available yet
 */
export const Empty: Story = {
  render: () => <ProfileSelectorWrapper profiles={[]} />,
};

/**
 * Loading state while fetching profiles
 */
export const Loading: Story = {
  render: () => <ProfileSelectorWrapper isLoading />,
};

/**
 * Error state when profiles failed to load
 */
export const Error: Story = {
  render: () => <ProfileSelectorWrapper error />,
};

/**
 * Disabled state (e.g., during session execution)
 */
export const Disabled: Story = {
  render: () => <ProfileSelectorWrapper disabled initialSelectedId="profile-1" />,
};

/**
 * Single profile available
 */
export const SingleProfile: Story = {
  render: () => (
    <ProfileSelectorWrapper profiles={[mockProfiles[0]]} initialSelectedId="profile-1" />
  ),
};

/**
 * Many profiles - shows scrolling behavior
 */
export const ManyProfiles: Story = {
  render: () => {
    const manyProfiles: ProfileSummary[] = Array.from({ length: 15 }, (_, i) => ({
      id: `profile-${i + 1}`,
      name: `Profile ${i + 1}`,
      description: i % 2 === 0 ? `Description for profile ${i + 1}` : null,
      isDefault: i === 0,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      varCount: Math.floor(Math.random() * 10),
      commandCount: Math.floor(Math.random() * 5),
    }));
    return <ProfileSelectorWrapper profiles={manyProfiles} />;
  },
};
