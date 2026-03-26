'use client';

import { IntegrationsHub } from '@/components/integrations/IntegrationsHub';
import { SetPageTitle } from '@/components/SetPageTitle';
import { PageContainer } from '@/components/layouts/PageContainer';

export function IntegrationsPageClient() {
  return (
    <PageContainer>
      <SetPageTitle title="Integrations" />
      <div className="mb-8">
        <p className="text-muted-foreground mt-2">
          Connect your development tools and workflows with Kilocode
        </p>
      </div>
      <IntegrationsHub />
    </PageContainer>
  );
}
