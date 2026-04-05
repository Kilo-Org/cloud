import { describe, it, expect } from 'vitest';
import { isValidImageTag, IMAGE_TAG_MAX_LENGTH } from './image-tag-validation';

describe('image tag validation', () => {
  describe('valid tags', () => {
    const valid = [
      'latest',
      'dev-1771888037',
      '2026.2.25-abc123',
      'v1.0.0',
      'my_tag',
      'a',
      '1',
      'sha-abc123def',
      'release-2026.02.25_build.42',
    ];

    it.each(valid)('accepts %s', tag => {
      expect(isValidImageTag(tag)).toBe(true);
    });
  });

  describe('invalid tags', () => {
    const invalid: [string, string][] = [
      ['', 'empty string'],
      [' ', 'whitespace only'],
      ['tag with spaces', 'contains spaces'],
      ['-starts-with-dash', 'starts with dash'],
      ['.starts-with-dot', 'starts with dot'],
      ['_starts-with-underscore', 'starts with underscore'],
      ['tag:colon', 'contains colon'],
      ['tag/slash', 'contains slash'],
      ['../../../etc/passwd', 'path traversal'],
      ['tag;rm -rf /', 'command injection with semicolon'],
      ['tag$(whoami)', 'command injection with subshell'],
      ['tag`whoami`', 'command injection with backticks'],
      ['tag\nnewline', 'contains newline'],
      ['tag\ttab', 'contains tab'],
      ['tag<script>', 'contains angle brackets'],
      ['tag&amp;', 'contains ampersand'],
      ['tag|pipe', 'contains pipe'],
      ['tag\\backslash', 'contains backslash'],
    ];

    it.each(invalid)('rejects "%s" (%s)', (tag, _desc) => {
      expect(isValidImageTag(tag)).toBe(false);
    });
  });

  describe('length limits', () => {
    it('accepts tag at max length', () => {
      const tag = 'a'.repeat(IMAGE_TAG_MAX_LENGTH);
      expect(isValidImageTag(tag)).toBe(true);
    });

    it('rejects tag exceeding max length', () => {
      const tag = 'a'.repeat(IMAGE_TAG_MAX_LENGTH + 1);
      expect(isValidImageTag(tag)).toBe(false);
    });
  });
});
