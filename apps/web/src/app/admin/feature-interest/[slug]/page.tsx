'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { FeatureInterestUserList } from '@/app/admin/components/FeatureInterestUserList';
import { useFeatureInterestDetail } from '@/app/admin/api/features/interest/hooks';

export default function FeatureInterestDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const searchParams = useSearchParams();
  // Get the feature name from the query parameter if available
  const featureName = searchParams.get('name');
  const { data, isLoading, error } = useFeatureInterestDetail(slug, featureName);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/feature-interest">Feature Interest</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{data?.feature ?? slug}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  if (isLoading) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Feature Interest: {slug}</h2>
          </div>
          <div>Loading...</div>
        </div>
      </AdminPage>
    );
  }

  if (error || !data) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Feature Interest: {slug}</h2>
          </div>
          <div className="text-red-500">
            Error: {error instanceof Error ? error.message : 'Failed to load feature data'}
          </div>
        </div>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{data.feature}</h2>
            <p className="text-muted-foreground mt-1">
              Users who signed up for early access to this feature.
            </p>
          </div>
          <Link
            href="/admin/feature-interest"
            className="hover:bg-background inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
          >
            ← Back to Overview
          </Link>
        </div>

        <FeatureInterestUserList
          feature={data.feature}
          users={data.users}
          totalCount={data.total_count}
          usersQuery={data.usersQuery}
          countQuery={data.countQuery}
        />
      </div>
    </AdminPage>
  );
}
