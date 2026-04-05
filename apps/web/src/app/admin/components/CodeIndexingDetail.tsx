'use client';

import { useQuery } from '@tanstack/react-query';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { OrganizationCodeIndexing } from '@/components/organizations/OrganizationCodeIndexing';

type CodebaseIndexingDetailProps = {
  organizationId: string;
};

export function CodeIndexingDetail({ organizationId }: CodebaseIndexingDetailProps) {
  const trpc = useTRPC();

  // Fetch organization name from the summary stats
  // We'll fetch a large page size to try to find the organization
  const { data: statsData } = useQuery(
    trpc.codeIndexing.admin.getSummaryStats.queryOptions({
      page: 1,
      pageSize: 100,
    })
  );

  const organization = statsData?.items.find(s => s.organization_id === organizationId);
  const isLoading = !statsData;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/code-indexing">Managed Indexing</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>
          {isLoading ? 'Loading...' : organization?.organization_name || 'Organization'}
        </BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {isLoading ? (
              <Skeleton className="h-8 w-[300px]" />
            ) : (
              organization?.organization_name || 'Unknown Organization'
            )}
          </h2>
          <p className="text-muted-foreground">Code indexing details for this organization</p>
        </div>

        <OrganizationCodeIndexing
          organizationId={organizationId}
          isAdminView={true}
          hideHeader={true}
        />
      </div>
    </AdminPage>
  );
}
