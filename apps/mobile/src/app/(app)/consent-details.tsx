import { useLocalSearchParams } from 'expo-router';

import { ConsentDetails } from '@/components/consent/consent-details';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';

export default function ConsentDetailsScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();

  return <ConsentDetails mode={consentModeForSearchParam(mode)} />;
}
