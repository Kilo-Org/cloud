import { PullsClient } from './PullsClient';

/**
 * Pull requests page — proposals from forks to the upstream. Auth is
 * enforced by the parent layout; this is a thin server boundary that
 * hands off to the client.
 */
export default function WastelandRepoPullsPage() {
  return <PullsClient />;
}
