'use client';
import BigLoader from '@/components/BigLoader';
import type { Organization } from '@kilocode/db/schema';
import { useStripeSessionStatus } from '@/app/payments/hooks';
import { redirect } from 'next/navigation';

type Props = {
  organizationId: Organization['id'];
  sessionId: string;
};
export function StripeSessionStatusChecker({ organizationId, sessionId }: Props) {
  const result = useStripeSessionStatus({ sessionId });

  if (result.status === 'pending' && result.isFetching) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <BigLoader title="Processing Subscription" />
      </div>
    );
  }
  return redirect(`/organizations/${organizationId}`);
}
