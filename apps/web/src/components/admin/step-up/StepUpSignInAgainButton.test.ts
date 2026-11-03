import { describe, expect, it } from '@jest/globals';
import { performStepUpReauth, stepUpReauthCallbackUrl } from './StepUpSignInAgainButton';

describe('stepUpReauthCallbackUrl', () => {
  it('returns to the current admin path after a fresh sign-in', () => {
    expect(stepUpReauthCallbackUrl('/admin/users')).toBe(
      '/users/sign_in?callbackPath=%2Fadmin%2Fusers'
    );
  });

  it('falls back to the admin home for an empty path', () => {
    expect(stepUpReauthCallbackUrl('')).toBe('/users/sign_in?callbackPath=%2Fadmin');
  });
});

describe('performStepUpReauth', () => {
  it('revokes sessions before signing out to the current path', async () => {
    const calls: string[] = [];
    await performStepUpReauth({
      pathname: '/admin/users',
      revoke: async () => {
        calls.push('revoke');
      },
      signOut: async options => {
        calls.push(`signOut:${options.callbackUrl}`);
      },
    });

    expect(calls).toEqual(['revoke', 'signOut:/users/sign_in?callbackPath=%2Fadmin%2Fusers']);
  });

  it('still signs out when revocation fails', async () => {
    const signOut = jest.fn(async (_options: { callbackUrl: string }) => {});
    await performStepUpReauth({
      pathname: '/admin',
      revoke: async () => {
        throw new Error('offline');
      },
      signOut,
    });

    expect(signOut).toHaveBeenCalledWith({
      callbackUrl: '/users/sign_in?callbackPath=%2Fadmin',
    });
  });
});
