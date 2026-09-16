import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { WORKTREE_STATE_GRANT_SECONDS } from '../shared/worktree-state.js';
import { mintWorktreeStateGrant, validateWorktreeStateGrant } from './worktree-state-grant.js';

const secret = 'test-worktree-state-secret';
const identity = { userId: 'usr_test', scopeId: 'worktree_abc-123' };

describe('worktree state grant', () => {
  it('round-trips the worktree scope it was minted for', () => {
    const grant = mintWorktreeStateGrant(identity, secret);
    expect(validateWorktreeStateGrant(`Bearer ${grant}`, secret)).toEqual(identity);
  });

  it('refuses grants signed by another secret or minted for another audience', () => {
    const grant = mintWorktreeStateGrant(identity, secret);
    expect(validateWorktreeStateGrant(`Bearer ${grant}`, 'other-secret')).toBeUndefined();
    expect(
      validateWorktreeStateGrant(
        `Bearer ${jwt.sign({ type: 'worktree_state', identity }, secret, {
          algorithm: 'HS256',
          audience: 'cloud-agent-control-log-upload',
          expiresIn: 60,
        })}`,
        secret
      )
    ).toBeUndefined();
  });

  it('refuses malformed headers, missing secrets and expired grants', () => {
    const grant = mintWorktreeStateGrant(identity, secret);
    expect(validateWorktreeStateGrant(null, secret)).toBeUndefined();
    expect(validateWorktreeStateGrant(grant, secret)).toBeUndefined();
    expect(validateWorktreeStateGrant(`Bearer ${grant}`, null)).toBeUndefined();

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime((WORKTREE_STATE_GRANT_SECONDS + 60) * 1000);
      expect(validateWorktreeStateGrant(`Bearer ${grant}`, secret)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a grant whose lifetime exceeds the ceiling', () => {
    const forged = jwt.sign({ type: 'worktree_state', identity }, secret, {
      algorithm: 'HS256',
      audience: 'cloud-agent-worktree-state',
      expiresIn: WORKTREE_STATE_GRANT_SECONDS * 4,
    });
    expect(validateWorktreeStateGrant(`Bearer ${forged}`, secret)).toBeUndefined();
  });

  it('round-trips federated oauth user ids', () => {
    const federated = { userId: 'oauth/google:1234', scopeId: 'worktree_abc-123' };
    const grant = mintWorktreeStateGrant(federated, secret);
    expect(validateWorktreeStateGrant(`Bearer ${grant}`, secret)).toEqual(federated);
  });

  it('refuses identities the object key schema would not accept', () => {
    expect(() => mintWorktreeStateGrant({ userId: '../etc', scopeId: 'ok' }, secret)).toThrow();
    expect(() => mintWorktreeStateGrant({ userId: 'usr', scopeId: 'a/b' }, secret)).toThrow();
    expect(() =>
      mintWorktreeStateGrant({ userId: 'oauth/../etc', scopeId: 'ok' }, secret)
    ).toThrow();
  });
});
