import { SafetyIdentifiersBackfill } from '../components/SafetyIdentifiersBackfill';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Safety Identifiers</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function SafetyIdentifiersPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Safety Identifier Backfill</h2>
        </div>
        <SafetyIdentifiersBackfill />
      </div>
    </AdminPage>
  );
}
