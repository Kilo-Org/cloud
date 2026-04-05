import { AbuseBulkBlock } from '../components/AbuseBulkBlock';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Bulk Block Users</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function BulkBlockPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Bulk Block Users</h2>
        </div>

        <AbuseBulkBlock />
      </div>
    </AdminPage>
  );
}
