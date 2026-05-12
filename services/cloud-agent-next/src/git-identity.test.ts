/**
 * Tests for GitIdentity-related helpers: buildGitAuthor.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    setTags: vi.fn(),
    withTags: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    withFields: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  withLogTags: () => (_target: unknown, _key: string, descriptor: PropertyDescriptor) => descriptor,
}));

import { buildGitAuthor } from './workspace.js';
import type { GitIdentity } from './types/git-identity.js';

describe('buildGitAuthor', () => {
  describe('app identity', () => {
    it('returns bot name and noreply email for standard app', () => {
      const identity: GitIdentity = {
        kind: 'app',
        slug: 'kiloconnect',
        botUserId: '240665456',
      };
      expect(buildGitAuthor(identity)).toEqual({
        name: 'kiloconnect[bot]',
        email: '240665456+kiloconnect[bot]@users.noreply.github.com',
      });
    });

    it('handles lite app slug', () => {
      const identity: GitIdentity = {
        kind: 'app',
        slug: 'kiloconnect-lite',
        botUserId: '257753004',
      };
      expect(buildGitAuthor(identity)).toEqual({
        name: 'kiloconnect-lite[bot]',
        email: '257753004+kiloconnect-lite[bot]@users.noreply.github.com',
      });
    });
  });

  describe('user identity with verified email', () => {
    it('uses the provided email (gives Verified badge on commits)', () => {
      const identity: GitIdentity = {
        kind: 'user',
        login: 'octocat',
        userId: '583231',
        email: 'octocat@github.com',
      };
      expect(buildGitAuthor(identity)).toEqual({
        name: 'octocat',
        email: 'octocat@github.com',
      });
    });
  });

  describe('user identity without email', () => {
    it('falls back to GitHub noreply address when email is null', () => {
      const identity: GitIdentity = {
        kind: 'user',
        login: 'octocat',
        userId: '583231',
        email: null,
      };
      expect(buildGitAuthor(identity)).toEqual({
        name: 'octocat',
        email: '583231+octocat@users.noreply.github.com',
      });
    });
  });
});
