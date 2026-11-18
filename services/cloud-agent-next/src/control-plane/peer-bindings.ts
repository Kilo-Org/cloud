import type { Env } from '../types.js';

/** Minimal namespace shape both V2 peer resolutions need. */
export type PeerNamespace<TPeer> = {
  getByName(name: string): TPeer;
};

/**
 * The one place the V2 DO peer-binding names are chosen. C1c flips the
 * production class exports, so both V2 DOs resolve peers from the production
 * `SANDBOX_CONTROL`/`SANDBOX_SESSION` bindings. The test Worker binds the same
 * names to the V2 classes.
 */
const SANDBOX_CONTROL_PEER_BINDING = 'SANDBOX_CONTROL';
const SANDBOX_SESSION_PEER_BINDING = 'SANDBOX_SESSION';

export function sandboxControlPeerNamespace<TPeer>(env: Env): PeerNamespace<TPeer> | undefined {
  return readPeerNamespace<TPeer>(env, SANDBOX_CONTROL_PEER_BINDING);
}

export function sandboxSessionPeerNamespace<TPeer>(env: Env): PeerNamespace<TPeer> | undefined {
  return readPeerNamespace<TPeer>(env, SANDBOX_SESSION_PEER_BINDING);
}

function readPeerNamespace<TPeer>(env: Env, binding: string): PeerNamespace<TPeer> | undefined {
  return (env as unknown as Record<string, PeerNamespace<TPeer> | undefined>)[binding];
}
