import AdminPage from '../components/AdminPage';
import { SupportAccessContent } from './SupportAccessContent';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Support access</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function SupportAccessPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold">Support organization access</h2>
          <p className="text-muted-foreground text-sm">
            Explicit, time-bounded access to a customer organization. Read grants start immediately;
            write grants need a second approver. Every grant is recorded in support-access events
            and admin telemetry.
          </p>
        </div>
        <SupportAccessContent />
      </div>
    </AdminPage>
  );
}
