'use client';

import type { ReactNode } from 'react';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationContextProvider } from './OrganizationContext';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { BYOKKeysManager } from './byok/BYOKKeysManager';
import { OpenAiChatGptCard, OpenAiChatGptCardView } from './byok/OpenAiChatGptCard';
import {
  canManageSharedServices,
  ChatGptSharedServicesCard,
  ChatGptSharedServicesCardView,
} from '@/components/chatgpt/ChatGptSharedServicesCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { CHATGPT_ACCESS_FLAG } from '@/lib/auth/openai/access';
import { ClaudeBillingCard } from './byok/ClaudeBillingCard';

/**
 * A titled group of connection cards. The cards decide for themselves whether
 * to render (release flags, existing links), so the group hides in CSS when
 * none of them did instead of repeating each card's gate here.
 */
function ConnectionSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="@container space-y-3 has-[>div:empty]:hidden">
      <header className="space-y-1">
        <h2 className="type-heading">{title}</h2>
        <p className="type-body text-muted-foreground">{description}</p>
      </header>
      <div className="grid gap-4 *:only:col-span-full @3xl:grid-cols-2">{children}</div>
    </section>
  );
}

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

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-4">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Bring Your Own Key"
          showBackButton={false}
        />
        <div className="space-y-8">
          <ConnectionSection
            title="Your connections"
            description="Used only for the requests you make in this organization. Every member links their own."
          >
            {chatGptEnabled === true ? (
              <OpenAiChatGptCard organizationId={organizationId} />
            ) : chatGptEnabled === undefined ? (
              <OpenAiChatGptCardView status={undefined} isOrganization />
            ) : null}
            <ClaudeBillingCard organizationId={organizationId} />
          </ConnectionSection>
          {hasPermission ? (
            <>
              <ConnectionSection
                title="Shared services"
                description="Used by Kilo shared services in this organization, such as code review. Only owners and admins can manage these."
              >
                {!canManageSharedServices(currentRole) ? null : chatGptEnabled === true ? (
                  <ChatGptSharedServicesCard organizationId={organizationId} />
                ) : chatGptEnabled === undefined ? (
                  <ChatGptSharedServicesCardView status={undefined} />
                ) : null}
                <ClaudeBillingCard organizationId={organizationId} scope="shared_services" />
              </ConnectionSection>
              <BYOKKeysManager organizationId={organizationId} />
            </>
          ) : chatGptEnabled === false ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Access Denied</AlertTitle>
              <AlertDescription>
                You must be an organization owner to manage organization API keys.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    </OrganizationContextProvider>
  );
}
