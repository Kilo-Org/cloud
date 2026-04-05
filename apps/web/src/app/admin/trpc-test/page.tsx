import { TestTrpcComponent } from '../../../components/trpc-test/TestTrpcComponent';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>TRPC Test</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function TestTrpcPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex min-h-screen flex-col bg-gray-900">
        <h1>Testing TRPC rendering</h1>
        <TestTrpcComponent />
      </div>
    </AdminPage>
  );
}
