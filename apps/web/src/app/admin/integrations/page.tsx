import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { GitHubInstallationLookup } from './GitHubInstallationLookup';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Integrations</BreadcrumbPage>
  </BreadcrumbItem>
);

export default function IntegrationsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <GitHubInstallationLookup />
    </AdminPage>
  );
}
