import { useLocalSearchParams } from 'expo-router';

import { ProviderKeyProviderPickerScreen } from '@/components/account/provider-key-provider-picker-screen';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

export default function ProviderKeyAddRoute() {
  const { org } = useLocalSearchParams<{ org?: string | string[] }>();
  return <ProviderKeyProviderPickerScreen organizationId={normalizeOrgQueryParam(org)} />;
}
