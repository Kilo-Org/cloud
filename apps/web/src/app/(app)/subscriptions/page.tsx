import { PersonalSubscriptions } from '@/components/subscriptions/PersonalSubscriptions';
import { CODING_PLANS_PURCHASE_ENABLED } from '@kilocode/web-shared/lib/config.server';

export default function SubscriptionsPage() {
  return <PersonalSubscriptions codingPlansEnabled={CODING_PLANS_PURCHASE_ENABLED} />;
}
