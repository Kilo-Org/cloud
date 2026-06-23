import { getUserFromAuth } from '@/lib/user/server';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/layouts/PageContainer';
import { McpGatewayDetailContent } from '../McpGatewayDetailContent';

export default async function McpGatewayDetailPage({
  params,
}: {
  params: Promise<{ configId: string }>;
}) {
  const { user } = await getUserFromAuth({ adminOnly: true });
  if (!user) notFound();
  const { configId } = await params;
  return (
    <PageContainer>
      <McpGatewayDetailContent configId={configId} />
    </PageContainer>
  );
}
