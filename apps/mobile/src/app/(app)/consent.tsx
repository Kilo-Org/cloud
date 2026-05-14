import { useLocalSearchParams } from 'expo-router';

import { ConsentCard } from '@/components/consent/consent-card';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';

export default function ConsentScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();

  return <ConsentCard mode={consentModeForSearchParam(mode)} />;
}
