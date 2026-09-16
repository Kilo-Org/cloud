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
  it('clears a remembered endpoint when the next attach omits it', () => {
    rememberWorktreeStateEndpoint(directory, endpoint);
    expect(worktreeStateEndpointFor(directory)).toEqual(endpoint);

    rememberWorktreeStateEndpoint(directory, undefined);
    expect(worktreeStateEndpointFor(directory)).toBeUndefined();
  });

  it('leaves a sibling directory untouched when one endpoint is cleared', () => {
    const sibling = '/workspace/b';
    rememberWorktreeStateEndpoint(directory, endpoint);
    rememberWorktreeStateEndpoint(sibling, { ...endpoint, grant: 'sibling' });

    rememberWorktreeStateEndpoint(directory, undefined);
    expect(worktreeStateEndpointFor(directory)).toBeUndefined();
    expect(worktreeStateEndpointFor(sibling)).toMatchObject({ grant: 'sibling' });
  });

  it('forgets an endpoint explicitly', () => {
    rememberWorktreeStateEndpoint(directory, endpoint);
    forgetWorktreeStateEndpoint(directory);
    expect(worktreeStateEndpointFor(directory)).toBeUndefined();
  });
});
