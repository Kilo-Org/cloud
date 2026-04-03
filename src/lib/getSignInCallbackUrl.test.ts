import { describe, test, expect } from '@jest/globals';
import getSignInCallbackUrl, { isValidCallbackPath, stripHost } from '@/lib/getSignInCallbackUrl';

describe('getSignInCallbackUrl', () => {
  describe('URL validity', () => {
    test('returns a valid URL with basic callback path', () => {
      const result = getSignInCallbackUrl();

      expect(() => new URL(result, 'http://example.com')).not.toThrow();
      expect(result).toBe('/users/after-sign-in');
    });
  });

  describe('callbackPath parameter handling', () => {
    test('passes valid callbackPath through after-sign-in', () => {
      const searchParams = { callbackPath: '/users/profile' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in?callbackPath=%2Fusers%2Fprofile');
    });

    test('does not allow admin paths', () => {
      const searchParams = { callbackPath: '/admin/path' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in');
    });

    test('does not allow URLs as callbackPath', () => {
      const searchParams = { callbackPath: 'http://example.com/foo' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in');
    });

    test('it supports dashes in the callbackPath', () => {
      const searchParams = { callbackPath: '/sign-in-to-editor' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in?callbackPath=%2Fsign-in-to-editor');
    });
  });

  describe('isValidCallbackPath', () => {
    describe('valid paths', () => {
      test('accepts simple paths', () => {
        expect(isValidCallbackPath('/profile')).toBe(true);
        expect(isValidCallbackPath('/sign-in-to-editor')).toBe(true);
        expect(isValidCallbackPath('/item-456')).toBe(true);
      });

      test('accepts paths with trailing slash', () => {
        expect(isValidCallbackPath('/profile/')).toBe(true);
      });

      test('accepts paths with query parameters', () => {
        expect(isValidCallbackPath('/profile?tab=settings')).toBe(true);
        expect(isValidCallbackPath('/profile/?tab=settings')).toBe(true);
      });

      test('accepts paths with hash fragments', () => {
        expect(isValidCallbackPath('/profile#section')).toBe(true);
        expect(isValidCallbackPath('/profile/#section')).toBe(true);
        expect(isValidCallbackPath('/users/profile#top')).toBe(true);
      });

      test('accepts paths with both query parameters and hash fragments', () => {
        expect(isValidCallbackPath('/profile?tab=settings#section')).toBe(true);
        expect(isValidCallbackPath('/users/profile?param=value#anchor')).toBe(true);
      });

      test('accepts users/ prefixed paths', () => {
        expect(isValidCallbackPath('/users/profile')).toBe(true);
      });

      test('accepts integrations/ prefixed paths', () => {
        expect(isValidCallbackPath('/integrations/github')).toBe(true);
        expect(isValidCallbackPath('/integrations/gitlab')).toBe(true);
      });
    });

    describe('invalid paths', () => {
      test('rejects paths without leading slash', () => {
        expect(isValidCallbackPath('profile')).toBe(false);
        expect(isValidCallbackPath('dashboard')).toBe(false);
        expect(isValidCallbackPath('users/profile')).toBe(false);
      });

      test('rejects empty string', () => {
        expect(isValidCallbackPath('')).toBe(false);
      });

      test('rejects root path', () => {
        expect(isValidCallbackPath('/')).toBe(false);
      });

      test('rejects paths with multiple segments', () => {
        expect(isValidCallbackPath('/admin/users')).toBe(false);
        expect(isValidCallbackPath('/api/v1/users')).toBe(false);
      });

      test('rejects paths with special characters', () => {
        expect(isValidCallbackPath('/profile@user')).toBe(false);
        expect(isValidCallbackPath('/path%20with%20spaces')).toBe(false);
        expect(isValidCallbackPath('/path+with+plus')).toBe(false);
        expect(isValidCallbackPath('/path.with.dots')).toBe(false);
        expect(isValidCallbackPath('/path_with_underscores')).toBe(false);
      });

      test('rejects URLs', () => {
        expect(isValidCallbackPath('http://example.com')).toBe(false);
        expect(isValidCallbackPath('https://example.com/path')).toBe(false);
        expect(isValidCallbackPath('//example.com/path')).toBe(false);
      });

      test('rejects users/ with multiple segments', () => {
        expect(isValidCallbackPath('/users/admin/panel')).toBe(false);
      });

      test('rejects paths with spaces', () => {
        expect(isValidCallbackPath('/user profile')).toBe(false);
      });

      test('rejects paths starting with double slash', () => {
        expect(isValidCallbackPath('//profile')).toBe(false);
      });
    });

    describe('edge cases', () => {
      test('handles reasonably long valid paths', () => {
        // Test a reasonable length path that should work
        const longPath = '/very-long-path-name-that-is-still-reasonable';
        expect(isValidCallbackPath(longPath)).toBe(true);

        // Test that extremely long paths are rejected (which is actually good for security)
        const veryLongPath = '/a'.repeat(100);
        expect(isValidCallbackPath(veryLongPath)).toBe(false);
      });

      test('handles paths with only numbers', () => {
        expect(isValidCallbackPath('/123')).toBe(true);
        expect(isValidCallbackPath('/users/456')).toBe(true);
      });

      test('handles paths with only dashes', () => {
        expect(isValidCallbackPath('/-')).toBe(true);
        expect(isValidCallbackPath('/---')).toBe(true);
      });

      test('handles complex query strings', () => {
        expect(isValidCallbackPath('/profile?a=1&b=2&c=hello%20world')).toBe(true);
        expect(isValidCallbackPath('/users/profile?redirect=/dashboard&tab=settings')).toBe(true);
      });
    });
  });

  describe('source parameter handling from searchParams', () => {
    test('does not include source parameter when searchParams.source is undefined', () => {
      const searchParams = { other: 'value' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in');
    });

    test('does not include source parameter when searchParams.source is empty string', () => {
      const searchParams = { source: '' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in');
    });

    test('does not include source parameter when searchParams.source is array', () => {
      const searchParams = { source: ['value1', 'value2'] };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in');
    });

    test('includes source parameter when searchParams.source is a non-empty string', () => {
      const searchParams = { source: 'vscode' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in?source=vscode');
    });

    test('includes im_ref when present', () => {
      const searchParams = { im_ref: 'impact-click-id-123' };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in?im_ref=impact-click-id-123');
    });
  });

  describe('parameter combinations', () => {
    test('handles complex searchParams with multiple values', () => {
      const searchParams = {
        source: 'extension',
        im_ref: 'impact-click-id-123',
        other: 'value',
        array: ['item1', 'item2'],
        empty: '',
      };
      const result = getSignInCallbackUrl(searchParams);

      expect(result).toBe('/users/after-sign-in?source=extension&im_ref=impact-click-id-123');
    });
  });

  describe('stripHost', () => {
    test('strips host from full URL and returns absolute path', () => {
      expect(stripHost('https://example.com/users/profile')).toBe('/users/profile');
      expect(stripHost('http://localhost:3000/dashboard')).toBe('/dashboard');
      expect(stripHost('https://app.example.com/users/settings?tab=profile')).toBe(
        '/users/settings?tab=profile'
      );
    });

    test('preserves query parameters and hash', () => {
      expect(stripHost('https://example.com/path?param=value&other=test')).toBe(
        '/path?param=value&other=test'
      );
      expect(stripHost('https://example.com/path#section')).toBe('/path#section');
      expect(stripHost('https://example.com/path?param=value#section')).toBe(
        '/path?param=value#section'
      );
    });

    test('returns path unchanged if already a path', () => {
      expect(stripHost('/users/profile')).toBe('/users/profile');
      expect(stripHost('/dashboard?tab=settings')).toBe('/dashboard?tab=settings');
      expect(stripHost('/path#section')).toBe('/path#section');
    });

    test('handles root path', () => {
      expect(stripHost('https://example.com/')).toBe('/');
      expect(stripHost('/')).toBe('/');
    });

    test('handles invalid URLs gracefully', () => {
      expect(stripHost('not-a-url')).toBe('not-a-url');
      expect(stripHost('')).toBe('');
      expect(stripHost('relative/path')).toBe('relative/path');
    });
  });
});
