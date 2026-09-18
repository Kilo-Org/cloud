import { describe, expect, it, afterEach } from 'bun:test';
import {
  forgetWorktreeStateEndpoint,
  rememberWorktreeStateEndpoint,
  resetWorktreeStateEndpoints,
  worktreeStateEndpointFor,
} from './worktree-state-endpoints';

const directory = '/workspace/a';
const endpoint = { url: 'https://worker.test/worktree-state/usr/w', grant: 'grant' };

afterEach(() => {
  resetWorktreeStateEndpoints();
});

describe('worktree-state endpoints', () => {
  it('retains a remembered endpoint when the next attach omits it', () => {
    rememberWorktreeStateEndpoint(directory, endpoint);
    expect(worktreeStateEndpointFor(directory)).toEqual(endpoint);

    // An omitted grant is not authoritative: the control plane omits it on
    // any minting failure, and a contained session never redelivers it.
    rememberWorktreeStateEndpoint(directory, undefined);
    expect(worktreeStateEndpointFor(directory)).toEqual(endpoint);
  });

  it('supersedes a remembered endpoint with a fresh grant', () => {
    rememberWorktreeStateEndpoint(directory, endpoint);
    const fresh = { ...endpoint, grant: 'fresh' };

    rememberWorktreeStateEndpoint(directory, fresh);
    expect(worktreeStateEndpointFor(directory)).toEqual(fresh);
  });

  it('leaves a sibling directory untouched when one endpoint is forgotten', () => {
    const sibling = '/workspace/b';
    rememberWorktreeStateEndpoint(directory, endpoint);
    rememberWorktreeStateEndpoint(sibling, { ...endpoint, grant: 'sibling' });

    forgetWorktreeStateEndpoint(directory);
    expect(worktreeStateEndpointFor(directory)).toBeUndefined();
    expect(worktreeStateEndpointFor(sibling)).toMatchObject({ grant: 'sibling' });
  });

  it('forgets an endpoint explicitly', () => {
    rememberWorktreeStateEndpoint(directory, endpoint);
    forgetWorktreeStateEndpoint(directory);
    expect(worktreeStateEndpointFor(directory)).toBeUndefined();
  });
});
