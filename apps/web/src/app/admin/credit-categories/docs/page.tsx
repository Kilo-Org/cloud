import ReactMarkdown from 'react-markdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { generatePromoCreditCategoriesMarkdown } from '@/lib/PromoCreditCategoryConfig';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { PageContainer } from '@/components/layouts/PageContainer';

// Server component to read and display the markdown file
export default function CreditCategoriesDocsPage() {
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
