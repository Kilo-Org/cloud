import AdminPage from '../components/AdminPage';
import { PlatformAdminsContent } from '../components/PlatformAdminsContent';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Admins</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function AdminsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Platform Admins</h2>
        </div>

        <PlatformAdminsContent />
      </div>
    </AdminPage>
  );
}
