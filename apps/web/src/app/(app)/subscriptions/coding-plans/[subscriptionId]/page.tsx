import { PageContainer } from '@/components/layouts/PageContainer';
import { CodingPlanDetail } from '@/components/subscriptions/coding-plans/CodingPlanDetail';

export default async function CodingPlanSubscriptionPage({
  params,
}: {
  params: Promise<{ subscriptionId: string }>;
}) {
  const { subscriptionId } = await params;

  return (
    <PageContainer>
      <CodingPlanDetail key={subscriptionId} subscriptionId={subscriptionId} />
    </PageContainer>
  );
}
