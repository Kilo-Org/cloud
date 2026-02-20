import type { UserDetailProps } from '@/types/admin';
import { UserAdminExternalLinks } from './UserAdminExternalLinks';
import { UserAdminCreditGrant } from './UserAdminCreditGrant';
import { UserAdminCreditTransactions } from './UserAdminCreditTransactions';
import { UserAdminPaymentMethods } from './UserAdminPaymentMethods';
import { UserAdminUsageBilling } from './UserAdminUsageBilling';
import { UserAdminAccountInfo } from './UserAdminAccountInfo';
import { UserAdminNotes } from './UserAdminNotes';
import { UserAdminGdprRemoval } from './UserAdminGdprRemoval';
import { UserAdminReferrals } from './UserAdminReferrals';
import { UserAdminStytchFingerprints } from './UserAdminStytchFingerprints';
import { UserAdminInvoices } from './UserAdminInvoices';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import { toGuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { UserAdminOrganizations } from '@/app/admin/components/UserAdmin/UserAdminOrganizations';
import { UserAdminKiloPass } from '@/app/admin/components/UserAdmin/UserAdminKiloPass';

export function UserAdminDashboard({ ...user }: UserDetailProps) {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/users">Users</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{user.google_user_email}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-8">
        <div className="flex flex-wrap gap-8">
          <UserAdminAccountInfo {...user} />
          <UserAdminExternalLinks {...user} />
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
          <UserAdminOrganizations organization_memberships={user.organization_memberships} />
          <UserAdminNotes {...user} />
          <UserAdminGdprRemoval {...user} />
          <UserAdminKiloPass userId={user.id} />
          <UserAdminUsageBilling {...user} />
          <UserAdminCreditGrant
            {...user}
            promoCreditCategories={promoCreditCategories.map(toGuiCreditCategory)}
          />
          <UserAdminStytchFingerprints {...user} />
          <UserAdminCreditTransactions {...user} />
          <UserAdminPaymentMethods {...user} />
          <UserAdminInvoices stripe_customer_id={user.stripe_customer_id} />
          <UserAdminReferrals kilo_user_id={user.id} />
        </div>
      </div>
    </AdminPage>
  );
}
