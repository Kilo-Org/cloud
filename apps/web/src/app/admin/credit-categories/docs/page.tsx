import ReactMarkdown from 'react-markdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { generatePromoCreditCategoriesMarkdown } from '@kilocode/web-shared/lib/PromoCreditCategoryConfig';
import { promoCreditCategories } from '@kilocode/web-shared/lib/promoCreditCategories';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { PageContainer } from '@/components/layouts/PageContainer';
import { requireAdminPage, AdminStepUpGate } from '@/lib/admin/require-admin-page';

export default async function CreditCategoriesDocsPage() {
  const adminAccess = await requireAdminPage();
  if (!adminAccess.user) {
    return <AdminStepUpGate requirement={adminAccess.stepUp} />;
  }

  const markdownContent = generatePromoCreditCategoriesMarkdown(promoCreditCategories);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/credit-categories">Credit Categories</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Documentation</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <PageContainer>
        <Card>
          <CardHeader>
            <CardTitle>Credit Categories Documentation</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose-invert">
              <ReactMarkdown>{markdownContent}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      </PageContainer>
    </AdminPage>
  );
}
