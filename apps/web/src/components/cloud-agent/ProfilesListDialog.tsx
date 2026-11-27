/** Opens profile management in Cloud Agent settings. */
'use client';

import {
  CloudAgentSettingsDialog,
  type SettingsSection,
} from '@/components/cloud-agent-next/settings/CloudAgentSettingsDialog';

type ProfilesListDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: 'profiles' | 'personal-profiles';
  onSectionChange?: (section: SettingsSection) => void;
  onProfileSelect?: (profileId: string) => void;
  orgProfilesOnly?: boolean;
  openToNewProfile?: boolean;
  initialSelectedProfileId?: string | null;
};

export function ProfilesListDialog({
  initialSection = 'profiles',
  ...props
}: ProfilesListDialogProps) {
  return <CloudAgentSettingsDialog {...props} initialSection={initialSection} />;
}
