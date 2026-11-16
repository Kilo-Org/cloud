import { useLocalSearchParams } from 'expo-router';

import { ProviderKeysScreen } from '@/components/account/provider-keys-screen';

export default function ProviderKeysRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <ProviderKeysScreen organizationId={org} />;
}
