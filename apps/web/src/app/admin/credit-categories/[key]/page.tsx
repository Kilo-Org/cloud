import { CreditCategoryUsersTable } from '../CreditCategoryUsers';
import { CreditCategoryStats } from './CreditCategoryStats';
import { promoCreditCategories } from '@kilocode/web-shared/lib/promoCreditCategories';
import {
  formatCategoryAsMarkdown,
  toGuiCreditCategory,
} from '@kilocode/web-shared/lib/PromoCreditCategoryConfig';
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
  // The dynamic segment arrives percent-encoded; Next rejects malformed encodings with 400 first.
  const categoryKey = decodeURIComponent(key);

  const category = promoCreditCategories.find(cat => cat.credit_category === categoryKey);

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/credit-categories">Credit Categories</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{categoryKey}</BreadcrumbPage>
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
        <CreditCategoryStats creditCategoryKey={categoryKey} />

        <CreditCategoryUsersTable creditCategoryKey={categoryKey} />
      </div>
    </AdminPage>
  );
}
