import { describe, expect, it } from 'vitest';

import {
  parseSkillMarkdown,
  skillErrorKey,
  skillRowSubtitle,
} from '@/components/profiles/skill-markdown';
import { validateSkillInput } from '@/lib/agent-profile-forms';

describe('parseSkillMarkdown', () => {
  it('parses an unquoted name and description', () => {
    const markdown = ['---', 'name: code-review', 'description: Reviews a diff', '---', ''].join(
      '\n'
    );
    expect(parseSkillMarkdown(markdown)).toEqual({
      name: 'code-review',
      description: 'Reviews a diff',
    });
  });

  it('strips matching quotes around the values', () => {
    const markdown = [
      '---',
      'name: "code-review"',
      "description: 'Reviews a diff'",
      '---',
      '',
    ].join('\n');
    expect(parseSkillMarkdown(markdown)).toEqual({
      name: 'code-review',
      description: 'Reviews a diff',
    });
  });

  it('returns nothing without a leading frontmatter block', () => {
    expect(parseSkillMarkdown('# Just markdown')).toEqual({});
    expect(parseSkillMarkdown('')).toEqual({});
  });

  it('returns a frontmatter name verbatim, so validation can reject its case', () => {
    const markdown = ['---', 'name: My-Skill', '---', 'Body'].join('\n');
    expect(parseSkillMarkdown(markdown).name).toBe('My-Skill');
  });
});

describe('skillErrorKey', () => {
  it('maps each validation code to its copy key', () => {
    expect(skillErrorKey('empty')).toBe('profiles.skillNameRequired');
    expect(skillErrorKey('bad-name')).toBe('profiles.skillNameInvalid');
    expect(skillErrorKey('no-content')).toBe('profiles.skillContentRequired');
  });

  it('maps an uppercase name to the invalid-name copy', () => {
    const result = validateSkillInput({ name: 'My-Skill', content: 'Body' });
    expect(result.error).toBe('bad-name');
    expect(skillErrorKey(result.error as 'bad-name')).toBe('profiles.skillNameInvalid');
  });

  it('maps whitespace-only content to the content-required copy', () => {
    const result = validateSkillInput({ name: 'my-skill', content: '   ' });
    expect(result.error).toBe('no-content');
    expect(skillErrorKey(result.error as 'no-content')).toBe('profiles.skillContentRequired');
  });
});

describe('skillRowSubtitle', () => {
  it('shows the server source type', () => {
    expect(skillRowSubtitle({ sourceType: 'custom' })).toBe('custom');
    expect(skillRowSubtitle({ sourceType: 'marketplace' })).toBe('marketplace');
  });
});
