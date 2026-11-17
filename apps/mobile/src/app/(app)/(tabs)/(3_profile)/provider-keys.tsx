import { useLocalSearchParams } from 'expo-router';

import { ProviderKeysScreen } from '@/components/account/provider-keys-screen';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

export default function ProviderKeysRoute() {
  const { org } = useLocalSearchParams<{ org?: string | string[] }>();
  return <ProviderKeysScreen organizationId={normalizeOrgQueryParam(org)} />;
}
