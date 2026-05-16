import { ForkClient } from './ForkClient';

/**
 * Fork (workshop) page — the user's `wl/<rigHandle>/*` branches on
 * their DoltHub fork. Auth is enforced by the parent layout; this is a
 * thin server boundary that hands off to the client.
 */
export default function WastelandRepoForkPage() {
  return <ForkClient />;
}
