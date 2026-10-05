import {
  WORKTREE_STATE_GRANT_SECONDS,
  worktreeStateIdentitySchema,
  type WorktreeStateIdentity,
} from '../shared/worktree-state.js';
import { createHs256GrantCodec } from './hs256-grant.js';

const codec = createHs256GrantCodec<WorktreeStateIdentity>({
  type: 'worktree_state',
  audience: 'cloud-agent-worktree-state',
  lifetimeSeconds: WORKTREE_STATE_GRANT_SECONDS,
  identitySchema: worktreeStateIdentitySchema,
});

export function mintWorktreeStateGrant(identity: WorktreeStateIdentity, secret: string): string {
  return codec.mint(identity, secret);
}

export function validateWorktreeStateGrant(
  authorization: string | null,
  secret: string | null
): WorktreeStateIdentity | undefined {
  return codec.validate(authorization, secret);
}
