'use client';

import { OrganizationInfoCard } from '@/components/organizations/OrganizationInfoCard';
import { OrganizationAdminMembers } from '@/components/organizations/OrganizationMembersCard';
import { OrganizationUsageSummaryCard } from '@/components/organizations/OrganizationUsageSummaryCard';
import { SeatUsageCard } from '@/components/organizations/SeatUsageCard';
import { OrganizationAdminCreditTransactions } from './OrganizationAdminCreditTransactions';
import { OrganizationAdminDelete } from './OrganizationAdminDelete';
import { OrganizationAdminCreditGrant } from './OrganizationAdminCreditGrant';
import { OrganizationAdminCreditNullify } from './OrganizationAdminCreditNullify';
import { OrganizationAdminCreatedBy } from './OrganizationAdminCreatedBy';
import { OrganizationWorkOSCard } from './OrganizationWorkOSCard';
import { OrganizationAdminWebhooks } from './OrganizationAdminWebhooks';
import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';

function OrganizationDetailAdminPage({
  children,
  organizationId,
}: {
  children: React.ReactNode;
  organizationId: string;
}) {
  const { data } = useOrganizationWithMembers(organizationId);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/organizations">Organizations</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{data?.name}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return <AdminPage breadcrumbs={breadcrumbs}>{children}</AdminPage>;
}

export function OrganizationAdminDashboard({ organizationId }: { organizationId: string }) {
  return (
    // in admin, admins are always owners of every organization
    <OrganizationContextProvider value={{ userRole: 'owner', isKiloAdmin: true }}>
      <OrganizationDetailAdminPage organizationId={organizationId}>
        <div className="flex w-full flex-col gap-y-8">
          <div className="w-full max-w-[1000px]">
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
              <div>
                <OrganizationInfoCard
                  organizationId={organizationId}
                  showAdminControls
                  className="h-full"
                />
              </div>
              <div className="space-y-7">
                <OrganizationUsageSummaryCard organizationId={organizationId} />
                <OrganizationAdminCreatedBy organizationId={organizationId} />
                <OrganizationAdminCreditGrant organizationId={organizationId} />
                <OrganizationAdminCreditNullify organizationId={organizationId} />
                <OrganizationWorkOSCard organizationId={organizationId} />
              </div>
              <div className="space-y-8 lg:col-span-2">
                <SeatUsageCard organizationId={organizationId} />
                <OrganizationAdminMembers organizationId={organizationId} showAdminLinks />
              </div>
              <div className="lg:col-span-2">
                <OrganizationAdminWebhooks organizationId={organizationId} />
              </div>
              <div className="lg:col-span-2">
                <OrganizationAdminCreditTransactions organizationId={organizationId} />
              </div>
              <div className="lg:col-span-2">
                <OrganizationAdminDelete organizationId={organizationId} />
              </div>
            </div>
          </div>
        </div>
      </OrganizationDetailAdminPage>
    </OrganizationContextProvider>
  );
}
