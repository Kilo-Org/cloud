import { describe, expect, it } from 'vitest';
import { PATTERN_ISSUE_MESSAGES, patternSafetyIssue } from './pattern-safety';

describe('pattern safety', () => {
  it.each([
    '^issue\\.(opened|closed)$',
    'issue\\.(opened|closed)',
    '^https://example\\.com/issues/[0-9]+$',
    '^[a-z0-9-]+$',
    '(?:foo|bar)+',
    '^(?:true|false)$',
    '(\\d{1,3}\\.){3}\\d{1,3}',
    '^(a{1,3}){1,3}$',
    '^(ab){2,5}$',
    '^v\\d+\\.\\d+\\.\\d+(-[0-9a-z.]+)?$',
    '(?<year>\\d{4})-(?<month>\\d{2})',
    '\\p{L}+',
    '(?=.*foo)bar',
    'a{1,1000}',
    'a{2,}',
    'colou?r',
    'a+?',
    '[\\w.-]+',
    '[-a-z]',
    '(?:😀|😁)+',
    '[😀-😃]+',
    '^(?:cat|cow)+$',
    '^(?:foo|far)+$',
    '(?:(?:ab|ac)x)+',
    '(?:[ab]x|[ab]y)+',
    '^a{1,4}a{1,4}a{1,2}b$',
    '(a{1,4}a{1,4}){2}',
    '(?=a{1,4}a{1,4}b)x',
    '(?:ab)+a+',
    '^(?:\\d{3}-)?\\d{3}$',
  ])('accepts %s', pattern => {
    expect(patternSafetyIssue(pattern)).toBeNull();
  });

  it.each([
    ['^(a+)+$', PATTERN_ISSUE_MESSAGES.nested],
    ['(a*)*', PATTERN_ISSUE_MESSAGES.nested],
    ['(a{1,3})+', PATTERN_ISSUE_MESSAGES.nested],
    ['(.*)+', PATTERN_ISSUE_MESSAGES.nested],
    ['(.*a){10}', PATTERN_ISSUE_MESSAGES.nested],
    ['([a-z]+-)+', PATTERN_ISSUE_MESSAGES.nested],
    ['^(?:[a-z]+\\.)+[a-z]{2,}$', PATTERN_ISSUE_MESSAGES.nested],
    ['((a{1,3}){1,3}){1,30}', PATTERN_ISSUE_MESSAGES.nested],
    ['^' + 'a+'.repeat(20) + 'b$', PATTERN_ISSUE_MESSAGES.nested],
    ['(?=a{1,4}a{1,4}a{1,4}a{1,4}b)x', PATTERN_ISSUE_MESSAGES.nested],
    ['a{1,4}a{1,4}a{1,5}b', PATTERN_ISSUE_MESSAGES.nested],
    ['(a{1,8}a{1,8}){2}', PATTERN_ISSUE_MESSAGES.nested],
    ['a{1,100}(?:b{1,100})?a{1,100}', PATTERN_ISSUE_MESSAGES.nested],
    ['(a|a)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(a|aa)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(a|b|a)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(a|)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(\\s|\\s)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['((a|a)|b)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(?:(a|a)x)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(?:x(a|a))+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(?:😀|😀)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(?:ab|abc)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(?:a|ab)+', PATTERN_ISSUE_MESSAGES.ambiguous],
    ['(a)\\1', PATTERN_ISSUE_MESSAGES.backreference],
    ['(?<x>a)\\k<x>', PATTERN_ISSUE_MESSAGES.backreference],
  ])('refuses %s', (pattern, message) => {
    expect(patternSafetyIssue(pattern)).toBe(message);
  });

  it('accepts a deeply grouped pattern', () => {
    const pattern = '('.repeat(400) + 'a' + ')'.repeat(400);
    const started = Date.now();
    expect(patternSafetyIssue(pattern)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('accepts classes and escapes that are only narrowable by expansion', () => {
    for (const pattern of ['[\\d\\w]', '[^,]', '\\x41+\\u00e9', '\\cA', '[a-z\\-]+']) {
      expect(patternSafetyIssue(pattern)).toBeNull();
    }
  });
});
