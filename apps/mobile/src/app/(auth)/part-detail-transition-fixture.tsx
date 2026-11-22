import { Redirect, useLocalSearchParams } from 'expo-router';
import { z } from 'zod';

import { PartDetailTransitionFixture } from '@/components/agents/part-detail-transition-fixture';

const fixtureParams = z.object({
  open: z.enum(['file', 'missing']).optional(),
  state: z.enum(['completed', 'running']).optional(),
  media: z.enum(['loaded', 'loading', 'failed', 'superseded']).optional(),
});
const fixturePartIds = { file: 'part-detail-transition-file', missing: 'missing-part' };

export default function PartDetailTransitionFixtureRoute() {
  const parsed = fixtureParams.safeParse(useLocalSearchParams());
  const initialPartId =
    parsed.success && parsed.data.open ? fixturePartIds[parsed.data.open] : undefined;
  const state = parsed.success ? parsed.data.state : undefined;
  const media = parsed.success ? parsed.data.media : undefined;
  return __DEV__ ? (
    <PartDetailTransitionFixture
      key={`${initialPartId ?? 'chat'}:${state ?? 'completed'}:${media ?? 'none'}`}
      initialPartId={initialPartId}
      state={state}
      media={media}
    />
  ) : (
    <Redirect href="/(auth)/login" />
  );
}
