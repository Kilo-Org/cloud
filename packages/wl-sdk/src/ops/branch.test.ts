import { describe, expect, it } from 'vitest';
import { makeRegisterBranch, makeWlBranch, parseWlBranch, rigBranchPrefix } from './branch';

describe('branch helpers', () => {
  it('makeWlBranch composes wl/<rig>/<id>', () => {
    expect(makeWlBranch('alice', 'w-001')).toBe('wl/alice/w-001');
  });

  it('makeRegisterBranch composes wl/register/<rig>', () => {
    expect(makeRegisterBranch('alice')).toBe('wl/register/alice');
  });

  it('rigBranchPrefix is wl/<rig>/', () => {
    expect(rigBranchPrefix('alice')).toBe('wl/alice/');
  });

  it('parses a wanted-mutation branch', () => {
    expect(parseWlBranch('wl/alice/w-001')).toEqual({
      kind: 'wanted',
      rigHandle: 'alice',
      wantedId: 'w-001',
    });
  });

  it('parses a registration branch', () => {
    expect(parseWlBranch('wl/register/alice')).toEqual({
      kind: 'register',
      rigHandle: 'alice',
    });
  });

  it('returns null for non-wl branches', () => {
    expect(parseWlBranch('main')).toBeNull();
    expect(parseWlBranch('feature/x')).toBeNull();
    expect(parseWlBranch(null)).toBeNull();
    expect(parseWlBranch('')).toBeNull();
  });

  it('returns null for malformed wl branches', () => {
    expect(parseWlBranch('wl/')).toBeNull();
    expect(parseWlBranch('wl/alice')).toBeNull();
    expect(parseWlBranch('wl/alice/')).toBeNull();
    // wantedId with embedded slash is not a single id
    expect(parseWlBranch('wl/alice/w/with/slash')).toBeNull();
  });

  it('register branch with embedded slash is not parseable', () => {
    expect(parseWlBranch('wl/register/alice/extra')).toBeNull();
  });
});
