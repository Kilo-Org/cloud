import { describe, expect, it } from 'vitest';

import { skillErrorKey, skillRowSubtitle } from '@/components/profiles/skill-markdown';
import { validateSkillInput } from '@/lib/agent-profile-forms';

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
  it('maps each server source type to its copy key', () => {
    expect(skillRowSubtitle({ sourceType: 'custom' })).toBe('profiles.skillSourceCustom');
    expect(skillRowSubtitle({ sourceType: 'marketplace' })).toBe('profiles.skillSourceMarketplace');
  });

  it('returns null for a source type without copy', () => {
    expect(skillRowSubtitle({ sourceType: 'imported' })).toBeNull();
  });
});
