import type { UserDetailProps } from '@/types/admin';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { UserAdminTabbedSections } from '@/app/admin/components/UserAdmin/UserAdminTabbedSections';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import { toGuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';

const guiCreditCategories = promoCreditCategories.map(toGuiCreditCategory);

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
      <div className="flex w-full flex-col gap-y-4">
        <UserAdminTabbedSections {...user} promoCreditCategories={guiCreditCategories} />
      </div>
    </AdminPage>
  );
}
