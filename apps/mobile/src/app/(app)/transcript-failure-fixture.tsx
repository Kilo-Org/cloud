import { TranscriptStyleFixture } from '@/components/agents/transcript-style-fixture';

/**
 * Development-only route for the design gate: the shared transcript renderer
 * with the added failed turn, so a contentless assistant row and its Retry are
 * measured on the plain screen rather than inside a form sheet. The
 * development fixture path in `src/app/+native-intent.tsx` maps to it.
 */
export default function TranscriptFailureFixtureRoute() {
  return <TranscriptStyleFixture />;
}
