import { CreditCategoryUsersTable } from '../CreditCategoryUsers';
import { CreditCategoryStats } from './CreditCategoryStats';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import { formatCategoryAsMarkdown, toGuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import ReactMarkdown from 'react-markdown';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface CreditCategoryDetailPageProps {
  params: Promise<{
    key: string;
  }>;
}

export default async function CreditCategoryDetailPage({ params }: CreditCategoryDetailPageProps) {
  const { key } = await params;
  const decodedKey = decodeURIComponent(key);

  // Find the specific credit category
  const category = promoCreditCategories.find(cat => cat.credit_category === decodedKey);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/credit-categories">Credit Categories</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{decodedKey}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="space-y-6">
        {/* Credit Category Summary */}
        <div className="space-y-4">
          {category && (
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown>
                {formatCategoryAsMarkdown(toGuiCreditCategory(category))}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <CreditCategoryStats creditCategoryKey={decodedKey} />

        <CreditCategoryUsersTable creditCategoryKey={decodedKey} />
      </div>
    </AdminPage>
  );
}
