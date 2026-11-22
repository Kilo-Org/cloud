import { describe, expect, it } from 'vitest';

import {
  instructionErrorKey,
  instructionNameErrorShown,
  instructionNameHint,
} from '@/components/profiles/instruction-model';
import {
  cleanInstructionName,
  INSTRUCTION_CONTENT_MAX_LENGTH,
  INSTRUCTION_NAME_MAX_LENGTH,
  MAX_PROFILE_INSTRUCTIONS,
  validateInstructionInput,
} from '@/lib/agent-profile-forms';

describe('validateInstructionInput', () => {
  it('accepts a slug name with content', () => {
    expect(validateInstructionInput({ name: 'release-notes', content: '# Rules' })).toBeNull();
  });

  it('accepts a typed name that saves as its slug', () => {
    expect(validateInstructionInput({ name: 'Release Notes', content: 'x' })).toBeNull();
    expect(cleanInstructionName('Release Notes')).toBe('release-notes');
    expect(validateInstructionInput({ name: 'UPPER', content: 'x' })).toBeNull();
  });

  it('refuses a blank or whitespace name as empty', () => {
    expect(validateInstructionInput({ name: '   ', content: 'x' })).toBe('empty');
  });

  it('refuses a name with nothing the slug accepts as invalid, not empty', () => {
    expect(validateInstructionInput({ name: 'قواعد', content: 'x' })).toBe('bad-name');
    expect(validateInstructionInput({ name: '規則', content: 'x' })).toBe('bad-name');
    expect(validateInstructionInput({ name: '!!!', content: 'x' })).toBe('bad-name');
  });

  it('accepts a typed name over the server bound, because the save is cut to it', () => {
    const name = 'a'.repeat(300);
    expect(validateInstructionInput({ name, content: 'x' })).toBeNull();
    expect(cleanInstructionName(name).length).toBeLessThanOrEqual(INSTRUCTION_NAME_MAX_LENGTH);
  });

  it('refuses the reserved Cloud-Agent rules file name', () => {
    expect(validateInstructionInput({ name: 'cloud-agent', content: 'x' })).toBe('reserved');
    expect(validateInstructionInput({ name: 'Cloud Agent', content: 'x' })).toBe('reserved');
  });

  it('refuses blank content', () => {
    expect(validateInstructionInput({ name: 'notes', content: '  \n ' })).toBe('no-content');
  });

  it('refuses content over the server bound', () => {
    const content = 'x'.repeat(INSTRUCTION_CONTENT_MAX_LENGTH + 1);
    expect(validateInstructionInput({ name: 'notes', content })).toBe('content-too-long');
  });

  it('mirrors the server instruction cap', () => {
    expect(MAX_PROFILE_INSTRUCTIONS).toBe(50);
  });
});

describe('cleanInstructionName', () => {
  it('reduces what a reader types to the server slug', () => {
    expect(cleanInstructionName('Release Notes')).toBe('release-notes');
    expect(cleanInstructionName('  rules/Setup  ')).toBe('rules-setup');
    expect(cleanInstructionName('my--name')).toBe('my-name');
  });

  it('folds diacritics the way the app search folds them', () => {
    expect(cleanInstructionName('Café Notes')).toBe('cafe-notes');
  });

  it('folds compatibility forms into the letters they stand for', () => {
    expect(cleanInstructionName('Ｒｅｌｅａｓｅ Ｎｏｔｅｓ')).toBe('release-notes');
    expect(instructionNameHint('ｒｕｌｅｓ')).toEqual({ kind: 'preview', slug: 'rules' });
  });

  it('leaves nothing for a name written in another script', () => {
    expect(cleanInstructionName('規則')).toBe('');
  });

  it('truncates to the server bound and drops a trailing dash', () => {
    const cleaned = cleanInstructionName(`${'a'.repeat(INSTRUCTION_NAME_MAX_LENGTH)} tail`);
    expect(cleaned.length).toBeLessThanOrEqual(INSTRUCTION_NAME_MAX_LENGTH);
    expect(cleaned.endsWith('-')).toBe(false);
  });
});

describe('instructionNameHint', () => {
  it('names the slug a save will store when it differs', () => {
    expect(instructionNameHint('Release Notes')).toEqual({
      kind: 'preview',
      slug: 'release-notes',
    });
  });

  it('says nothing for a blank or already-normalized name', () => {
    expect(instructionNameHint('   ')).toEqual({ kind: 'none' });
    expect(instructionNameHint('release-notes')).toEqual({ kind: 'none' });
  });

  it('states the rule when the fold leaves no ASCII name to save', () => {
    expect(instructionNameHint('規則')).toEqual({ kind: 'rule' });
    expect(instructionNameHint('पुणे कार्यालय नियम')).toEqual({ kind: 'rule' });
    expect(instructionNameHint('დრო')).toEqual({ kind: 'rule' });
  });

  it('previews a name the fold narrows but does not empty', () => {
    expect(instructionNameHint('Café Notes')).toEqual({ kind: 'preview', slug: 'cafe-notes' });
    expect(instructionNameHint('é')).toEqual({ kind: 'preview', slug: 'e' });
  });
});

describe('instructionErrorKey', () => {
  it('maps every error code to the copy that describes its field', () => {
    expect(instructionErrorKey('empty')).toBe('profiles.instructionNameRequired');
    expect(instructionErrorKey('reserved')).toBe('profiles.instructionNameReserved');
    expect(instructionErrorKey('no-content')).toBe('profiles.instructionContentRequired');
    expect(instructionErrorKey('content-too-long')).toBe('profiles.tooLong');
  });

  it('shows name errors under the name field only', () => {
    expect(instructionNameErrorShown('bad-name')).toBe(true);
    expect(instructionNameErrorShown('no-content')).toBe(false);
    expect(instructionNameErrorShown('content-too-long')).toBe(false);
  });
});
