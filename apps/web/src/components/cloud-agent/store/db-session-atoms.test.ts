import { describe, test, expect } from '@jest/globals';
import {
  extractRepoFromGitUrl,
  convertToCloudMessages,
  formatSessionDate,
  getSessionDisplayTitle,
} from './db-session-atoms';
import type { DbSession } from './db-session-atoms';

describe('extractRepoFromGitUrl', () => {
  test('should extract owner/repo from HTTPS URL', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  test('should extract owner/repo from HTTPS URL with .git suffix', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('should extract owner/repo from SSH URL', () => {
    expect(extractRepoFromGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  test('should extract owner/repo from SSH URL without .git suffix', () => {
    expect(extractRepoFromGitUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  test('should return undefined for null input', () => {
    expect(extractRepoFromGitUrl(null)).toBeUndefined();
  });

  test('should return undefined for undefined input', () => {
    expect(extractRepoFromGitUrl(undefined)).toBeUndefined();
  });

  test('should return undefined for empty string', () => {
    expect(extractRepoFromGitUrl('')).toBeUndefined();
  });

  test('should return undefined for invalid URL', () => {
    expect(extractRepoFromGitUrl('not-a-url')).toBeUndefined();
  });

  test('should handle GitLab SSH URLs', () => {
    expect(extractRepoFromGitUrl('git@gitlab.com:owner/repo.git')).toBe('owner/repo');
  });

  test('should handle URLs with nested paths', () => {
    // Only takes first two path segments as owner/repo
    expect(extractRepoFromGitUrl('https://github.com/owner/repo/tree/main')).toBe('owner/repo');
  });
});

describe('convertToCloudMessages', () => {
  test('should convert user_feedback messages to user type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'user_feedback',
        content: 'Hello from user',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
    expect(result[0].content).toBe('Hello from user');
    expect(result[0].ts).toBe(123456789);
  });

  test('should convert say messages (non-user_feedback) to assistant type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'Hello from assistant',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
  });

  test('should convert ask messages to assistant type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'ask',
        ask: 'completion_result',
        content: 'Please confirm',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
    expect(result[0].ask).toBe('completion_result');
  });

  test('should handle messages with timestamp string', () => {
    const dbMessages = [
      {
        timestamp: '2024-01-15T10:30:00Z',
        type: 'say',
        say: 'text',
        content: 'test',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(typeof result[0].ts).toBe('number');
    expect(result[0].ts).toBe(new Date('2024-01-15T10:30:00Z').getTime());
  });

  test('should preserve partial flag', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'partial message',
        partial: true,
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].partial).toBe(true);
  });

  test('should default partial to false when not present', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'complete message',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].partial).toBe(false);
  });

  test('should preserve metadata', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'api_req_started',
        metadata: { tokensIn: 100, tokensOut: 50 },
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].metadata).toEqual({ tokensIn: 100, tokensOut: 50 });
  });

  test('should parse tool metadata from text when missing', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'ask',
        ask: 'tool',
        text: '{"tool":"updateTodoList","todos":["[x] One","[ ] Two"]}',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].metadata).toEqual({
      tool: 'updateTodoList',
      todos: ['[x] One', '[ ] Two'],
    });
  });

  test('should return empty array for non-array input', () => {
    const result = convertToCloudMessages(
      'not an array' as unknown as Array<Record<string, unknown>>
    );
    expect(result).toEqual([]);
  });

  test('should handle empty array', () => {
    const result = convertToCloudMessages([]);
    expect(result).toEqual([]);
  });

  test('should handle messages with role field (alternative format)', () => {
    const dbMessages = [
      {
        ts: 123456789,
        role: 'user',
        content: 'User message via role field',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].type).toBe('user');
  });
});

describe('formatSessionDate', () => {
  test('should format recent time as "just now"', () => {
    const now = new Date();
    expect(formatSessionDate(now)).toBe('just now');
  });

  test('should format minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatSessionDate(fiveMinutesAgo)).toBe('5m ago');
  });

  test('should format hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatSessionDate(twoHoursAgo)).toBe('2h ago');
  });

  test('should format days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatSessionDate(threeDaysAgo)).toBe('3d ago');
  });

  test('should format older dates as month and day', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const result = formatSessionDate(twoWeeksAgo);
    expect(result).toMatch(/^[A-Z][a-z]+ \d+$/);
  });

  test('should accept string input', () => {
    const dateString = new Date().toISOString();
    expect(formatSessionDate(dateString)).toBe('just now');
  });
});

describe('getSessionDisplayTitle', () => {
  const baseSession: DbSession = {
    session_id: '123e4567-e89b-12d3-a456-426614174000',
    title: null,
    git_url: null,
    cloud_agent_session_id: null,
    created_on_platform: 'unknown',
    created_at: new Date(),
    updated_at: new Date(),
    last_mode: null,
    last_model: null,
    version: 0,
    organization_id: null,
  };

  test('should return title when present', () => {
    const session = { ...baseSession, title: 'My Test Session' };
    expect(getSessionDisplayTitle(session)).toBe('My Test Session');
  });

  test('should return long titles untruncated (CSS handles truncation)', () => {
    const longTitle = 'A'.repeat(100);
    const session = { ...baseSession, title: longTitle };
    const result = getSessionDisplayTitle(session);
    expect(result).toBe(longTitle);
  });

  test('should fall back to repository name', () => {
    const session = { ...baseSession, git_url: 'https://github.com/owner/repo' };
    expect(getSessionDisplayTitle(session)).toBe('owner/repo');
  });

  test('should fall back to session ID prefix', () => {
    expect(getSessionDisplayTitle(baseSession)).toBe('Session 123e4567');
  });
});
