/** Opens profile management in Cloud Agent settings. */
'use client';

import { CloudAgentSettingsDialog } from '@/components/cloud-agent-next/settings/CloudAgentSettingsDialog';

type ProfilesListDialogProps = {
  organizationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProfileSelect?: (profileId: string) => void;
  openToNewProfile?: boolean;
  initialSelectedProfileId?: string | null;
};

export function ProfilesListDialog(props: ProfilesListDialogProps) {
  return <CloudAgentSettingsDialog {...props} initialSection="profiles" />;
}
