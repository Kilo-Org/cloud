import { Code2 } from 'lucide-react';
import { AvailableProductCard } from '@/components/subscriptions/AvailableProductCard';
import { SubscriptionGroup } from '@/components/subscriptions/SubscriptionGroup';

export function CodingPlansGroup({ accordionValue }: { accordionValue?: string }) {
  return (
    <SubscriptionGroup
      title="Coding Plans"
      description="Coding Plans subscriptions are shipping in a follow-up change."
      headerIcon={<Code2 className="h-5 w-5" />}
      accordionValue={accordionValue}
    >
      <AvailableProductCard
        icon={<Code2 className="h-5 w-5" />}
        title="Coding Plans"
        description="Provider-backed coding plan subscriptions are coming soon."
        price="Coming soon"
        cta={{ label: 'Learn more', href: '/byok' }}
      />
    </SubscriptionGroup>
  );
}
