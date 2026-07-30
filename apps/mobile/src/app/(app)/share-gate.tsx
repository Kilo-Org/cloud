import { useLocalSearchParams } from 'expo-router';

import { ShareGateSheet } from '@/components/share/share-gate-sheet';

export default function ShareGateScreen() {
  const { shareId } = useLocalSearchParams<{ shareId?: string }>();
  // Param can be string | string[] depending on how the route was opened.
  const id = Array.isArray(shareId) ? shareId[0] : shareId;
  return <ShareGateSheet shareId={id} />;
}
