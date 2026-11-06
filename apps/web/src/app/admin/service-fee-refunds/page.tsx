import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { ServiceFeeRefunds } from '../components/ServiceFeeRefunds';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Service fee refunds</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function ServiceFeeRefundsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <h2 className="text-2xl font-bold">Service fee refunds</h2>
        <ServiceFeeRefunds />
      </div>
    </AdminPage>
  );
}
