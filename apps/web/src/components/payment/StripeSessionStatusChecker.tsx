'use client';
import BigLoader from '@/components/BigLoader';
import { useStripeSessionStatus } from '@/app/payments/hooks';
import { redirect } from 'next/navigation';

type Props = {
  organizationPath: string;
  sessionId: string;
};
export function StripeSessionStatusChecker({ organizationPath, sessionId }: Props) {
  const result = useStripeSessionStatus({ sessionId });

  if (result.status === 'pending' && result.isFetching) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <BigLoader title="Processing Subscription" />
      </div>
    );
  }
  return redirect(organizationPath);
}
