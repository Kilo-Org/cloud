'use client';

import { IntegrationsHub } from '@/components/integrations/IntegrationsHub';

type IntegrationsPageClientProps = {
  organizationId: string;
};

export function IntegrationsPageClient({ organizationId }: IntegrationsPageClientProps) {
  return <IntegrationsHub organizationId={organizationId} />;
}
