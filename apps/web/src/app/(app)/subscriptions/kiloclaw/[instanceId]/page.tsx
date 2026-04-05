import { PageContainer } from '@/components/layouts/PageContainer';
import { KiloClawDetail } from '@/components/subscriptions/kiloclaw/KiloClawDetail';

export default async function KiloclawSubscriptionPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  const { instanceId } = await params;
  return (
    <PageContainer>
      <KiloClawDetail instanceId={instanceId} />
    </PageContainer>
  );
}
