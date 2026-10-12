import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/layouts/PageContainer';
import { McpGatewayListContent } from './McpGatewayListContent';

export default async function McpGatewayPage() {
  const { user } = await getUserFromAuth({ adminOnly: true });
  if (!user) notFound();
  return (
    <PageContainer>
      <McpGatewayListContent />
    </PageContainer>
  );
}
