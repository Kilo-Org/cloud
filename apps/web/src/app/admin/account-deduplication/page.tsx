import { AccountDeduplicationTable } from '../components/AccountDeduplicationTable';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Account Deduplication</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function AccountDeduplicationPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Account Deduplication</h2>
        </div>
        <AccountDeduplicationTable />
      </div>
    </AdminPage>
  );
}
