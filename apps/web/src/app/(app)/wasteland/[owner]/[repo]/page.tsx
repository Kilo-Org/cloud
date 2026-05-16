import { UpstreamBoardClient } from './UpstreamBoardClient';

/**
 * Default landing for /wasteland/[owner]/[repo] — the read-only
 * upstream view. Auth + feature-flag gating happens in the parent
 * layout, so this is a thin server boundary that hands off to the
 * upstream board client.
 */
export default function WastelandRepoUpstreamPage() {
  return <UpstreamBoardClient />;
}
