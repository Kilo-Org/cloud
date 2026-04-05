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
import { UserCodeIndexingView } from '@/components/code-indexing/UserCodeIndexingView';

type UserCodeIndexingDetailProps = {
  userId: string;
};

export function UserCodeIndexingDetail({ userId }: UserCodeIndexingDetailProps) {
  const trpc = useTRPC();

  // Fetch user email from the summary stats
  // We'll fetch a large page size to try to find the user
  const { data: statsData } = useQuery(
    trpc.codeIndexing.admin.getUserSummaryStats.queryOptions({
      page: 1,
      pageSize: 100,
    })
  );

  const user = statsData?.items.find(s => s.kilo_user_id === userId);
  const isLoading = !statsData;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/code-indexing">Managed Indexing</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{isLoading ? 'Loading...' : user?.user_email || 'User'}</BreadcrumbPage>
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
              user?.user_email || 'Unknown User'
            )}
          </h2>
          <p className="text-muted-foreground">Code indexing details for this user</p>
        </div>

        <UserCodeIndexingView userId={userId} />
      </div>
    </AdminPage>
  );
}
