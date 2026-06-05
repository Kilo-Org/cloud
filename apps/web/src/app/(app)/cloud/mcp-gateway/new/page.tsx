import { getUserFromAuth } from '@/lib/user/server';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/layouts/PageContainer';
import { McpGatewaySetupContent } from '../McpGatewaySetupContent';

export default async function McpGatewaySetupPage() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) notFound();
  return (
    <PageContainer>
      <McpGatewaySetupContent />
    </PageContainer>
  );
}
