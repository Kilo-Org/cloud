import AdminPage from '../../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { KiloPassBulkCancel } from '../../components/KiloPassBulkCancel';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Kilo Pass Bulk Cancel</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function KiloPassBulkCancelPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Kilo Pass Bulk Cancel + Refund</h2>
        </div>
        <KiloPassBulkCancel />
      </div>
    </AdminPage>
  );
}
