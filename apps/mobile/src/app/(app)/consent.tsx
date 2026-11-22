import { useLocalSearchParams } from 'expo-router';

import { ConsentCard } from '@/components/consent/consent-card';
import { consentModeForSearchParam } from '@/components/consent/consent-mode';

export default function ConsentScreen() {
  const { mode, settingsTarget } = useLocalSearchParams<{
    mode?: string;
    settingsTarget?: string;
  }>();
  const consentMode = consentModeForSearchParam(mode);

  // Onboarding is the first-run surface, never a search destination: a target
  // rides only with the review screen a search result opens.
  return (
    <ConsentCard
      mode={consentMode}
      settingsTarget={consentMode === 'review' ? settingsTarget : undefined}
    />
  );
}
