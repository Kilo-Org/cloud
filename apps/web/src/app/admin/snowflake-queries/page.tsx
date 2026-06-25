import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { SnowflakeQueryMonitoringContent } from './SnowflakeQueryMonitoringContent';

export default function SnowflakeQueryMonitoringPage() {
  return (
    <AdminPage
      breadcrumbs={
        <BreadcrumbItem>
          <BreadcrumbPage>Snowflake queries</BreadcrumbPage>
        </BreadcrumbItem>
      }
    >
      <SnowflakeQueryMonitoringContent />
    </AdminPage>
  );
}
