import { useLocalSearchParams } from 'expo-router';

import { ProviderKeyProviderPickerScreen } from '@/components/account/provider-key-provider-picker-screen';

export default function ProviderKeyAddRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <ProviderKeyProviderPickerScreen organizationId={org} />;
}
