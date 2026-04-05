import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { InvoicesPageClient } from './InvoicesPageClient';
import { captureException } from '@sentry/nextjs';
import { PageLayout } from '@/components/PageLayout';
import { getStripeInvoices } from '@/lib/stripe';

export default async function InvoicesPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');

  try {
    const allInvoices = await getStripeInvoices(user.stripe_customer_id);

    return <InvoicesPageClient invoices={allInvoices} />;
  } catch (error) {
    captureException(error, {
      tags: { section: 'invoices' },
      extra: { userId: user.id },
    });
    return (
      <PageLayout title="Invoices">
        <p className="text-red-600">Unable to load invoices information. Please try again later.</p>
      </PageLayout>
    );
  }
}
