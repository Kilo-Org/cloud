'use client';

import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { CodeIndexingView } from '@/components/code-indexing/CodeIndexingView';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';

type OrganizationCodebaseIndexingProps = {
  organizationId: string;
  role?: OrganizationRole;
  isAdminView?: boolean;
  hideHeader?: boolean;
};

export function OrganizationCodeIndexing({
  organizationId,
  role,
  isAdminView = false,
  hideHeader = false,
}: OrganizationCodebaseIndexingProps) {
  // Fetch organization data to check if code indexing is enabled (only for non-admin view)
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const isEnabled = organizationData?.settings?.code_indexing_enabled;

  // Check if code indexing is enabled (skip check for admin view)
  const isCodeIndexingEnabled = isAdminView || !!isEnabled;

  if (!isAdminView && !isCodeIndexingEnabled) {
    return (
      <div className="flex flex-col gap-y-6">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Managed Indexing"
          badge={<Badge variant="new">new</Badge>}
        />
        <p className="text-muted-foreground -mt-2">
          View and manage indexed code for this organization
        </p>
        <a
          href="https://kilo.ai/docs/advanced-usage/managed-indexing"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
        >
          Learn how to use it
          <ExternalLink className="size-4" />
        </a>
        <Alert>
          <AlertDescription>
            Code indexing is not enabled for this organization. Contact your organization owner or
            Kilo support to enable this feature.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // Determine if user can delete branches
  const canDelete = isAdminView || role === 'owner';

  return (
    <div className="flex flex-col gap-y-6">
      {!hideHeader && (
        <>
          <OrganizationPageHeader
            organizationId={organizationId}
            title="Managed Indexing"
            badge={<Badge variant="new">new</Badge>}
          />
          <p className="text-muted-foreground -mt-2">
            View and manage indexed code for this organization
          </p>
          <a
            href="https://kilo.ai/docs/advanced-usage/managed-indexing"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
          >
            Learn how to use it
            <ExternalLink className="size-4" />
          </a>
        </>
      )}

      <CodeIndexingView
        organizationId={organizationId}
        isEnabled={isCodeIndexingEnabled}
        canDelete={canDelete}
        isAdminView={isAdminView}
      />
    </div>
  );
}
