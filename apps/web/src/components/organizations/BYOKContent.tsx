'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationContextProvider } from './OrganizationContext';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { BYOKKeysManager } from './byok/BYOKKeysManager';
import { OpenAiChatGptCard, OpenAiChatGptCardView } from './byok/OpenAiChatGptCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';

export function BYOKContent({
  organizationId,
  role,
}: {
  organizationId: string;
  role?: OrganizationRole;
}) {
  const { assumedRole } = useRoleTesting();
  const chatGptEnabled = useFeatureFlagEnabled(CHATGPT_ACCESS_FLAG);

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role || 'member';
  const isKiloAdmin = assumedRole === 'KILO ADMIN';

  // Check if user has permission to access BYOK (must be org owner or admin)
  const hasPermission = canManageOrganization(currentRole);

  const chatGptCard =
    chatGptEnabled === true ? (
      <OpenAiChatGptCard organizationId={organizationId} />
    ) : chatGptEnabled === undefined ? (
      <OpenAiChatGptCardView status={undefined} isOrganization />
    ) : null;

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-4">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Bring Your Own Key"
          showBackButton={false}
        />
        {/*
          The ChatGPT connection is personal, so every member manages their own
          for this organization and sees only that card. The pasted-key manager
          stays owner/admin only, so a member never sees the access-denied block.
        */}
        {hasPermission ? (
          <div className="space-y-4">
            {chatGptCard}
            <BYOKKeysManager organizationId={organizationId} />
          </div>
        ) : chatGptEnabled !== false ? (
          <div className="space-y-4">{chatGptCard}</div>
        ) : (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Access Denied</AlertTitle>
            <AlertDescription>
              You must be an organization owner to manage organization API keys.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </OrganizationContextProvider>
  );
}
