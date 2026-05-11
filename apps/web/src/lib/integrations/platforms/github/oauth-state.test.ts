import { createOAuthState, verifyOAuthState, safeReturnTo } from './oauth-state';
import { GITHUB_OAUTH_STATE_SECRET } from '@/lib/config.server';

describe('oauth-state', () => {
  describe('createOAuthState + verifyOAuthState', () => {
    test('round-trip works', () => {
      const state = createOAuthState({
        kilo_user_id: 'user-123',
        app_type: 'standard',
        return_to: '/account/integrations',
      });
      const decoded = verifyOAuthState(state);
      expect(decoded).not.toBeNull();
      expect(decoded?.kilo_user_id).toBe('user-123');
      expect(decoded?.app_type).toBe('standard');
      expect(decoded?.return_to).toBe('/account/integrations');
      expect(decoded?.nonce).toHaveLength(22); // 16 bytes base64url
    });

    test('rejects tampered signature', () => {
      const state = createOAuthState({
        kilo_user_id: 'user-123',
        app_type: 'standard',
      });
      const tampered = state.slice(0, -4) + 'xxxx';
      expect(verifyOAuthState(tampered)).toBeNull();
    });

    test('rejects expired state', () => {
      // Fast-forward jest time by 11 minutes
      jest.useFakeTimers();
      const state = createOAuthState({
        kilo_user_id: 'user-123',
        app_type: 'standard',
      });
      jest.advanceTimersByTime(11 * 60 * 1000);
      expect(verifyOAuthState(state)).toBeNull();
      jest.useRealTimers();
    });

    test('rejects missing state', () => {
      expect(verifyOAuthState(null)).toBeNull();
      expect(verifyOAuthState('')).toBeNull();
    });

    test('rejects malformed state', () => {
      expect(verifyOAuthState('no-dot')).toBeNull();
      expect(verifyOAuthState('a.b')).toBeNull();
    });
  });

  describe('safeReturnTo', () => {
    test('accepts relative paths', () => {
      expect(safeReturnTo('/account/integrations')).toBe('/account/integrations');
      expect(safeReturnTo('/settings/profile')).toBe('/settings/profile');
    });

    test('rejects absolute URLs', () => {
      expect(safeReturnTo('https://evil.com')).toBe('/account/integrations');
      expect(safeReturnTo('http://evil.com')).toBe('/account/integrations');
    });

    test('rejects protocol-relative URLs', () => {
      expect(safeReturnTo('//evil.com')).toBe('/account/integrations');
    });

    test('rejects javascript: URLs', () => {
      expect(safeReturnTo('javascript:alert(1)')).toBe('/account/integrations');
    });

    test('defaults when missing', () => {
      expect(safeReturnTo(undefined)).toBe('/account/integrations');
      expect(safeReturnTo(null)).toBe('/account/integrations');
    });
  });
});
