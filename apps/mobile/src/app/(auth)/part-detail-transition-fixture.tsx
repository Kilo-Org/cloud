import { Redirect, useLocalSearchParams } from 'expo-router';
import { z } from 'zod';

import { PartDetailTransitionFixture } from '@/components/agents/part-detail-transition-fixture';

const fixtureParams = z.object({ open: z.enum(['file', 'missing']).optional() });
const fixturePartIds = { file: 'part-detail-transition-file', missing: 'missing-part' };

export default function PartDetailTransitionFixtureRoute() {
  const parsed = fixtureParams.safeParse(useLocalSearchParams());
  const initialPartId =
    parsed.success && parsed.data.open ? fixturePartIds[parsed.data.open] : undefined;
  return __DEV__ ? (
    <PartDetailTransitionFixture key={initialPartId ?? 'chat'} initialPartId={initialPartId} />
  ) : (
    <Redirect href="/(auth)/login" />
  );
}
