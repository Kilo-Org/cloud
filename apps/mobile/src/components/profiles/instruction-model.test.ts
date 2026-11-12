import { describe, expect, it } from 'vitest';

import {
  instructionErrorKey,
  instructionNameErrorShown,
  instructionNamePreview,
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

  it('refuses a blank or whitespace name', () => {
    expect(validateInstructionInput({ name: '   ', content: 'x' })).toBe('empty');
  });

  it('refuses a name over the server bound', () => {
    const name = 'a'.repeat(INSTRUCTION_NAME_MAX_LENGTH + 1);
    expect(validateInstructionInput({ name, content: 'x' })).toBe('too-long');
  });

  it('refuses a name outside the server pattern', () => {
    expect(validateInstructionInput({ name: 'Release Notes', content: 'x' })).toBe('bad-name');
    expect(validateInstructionInput({ name: 'UPPER', content: 'x' })).toBe('bad-name');
  });

  it('refuses the reserved Cloud-Agent rules file name', () => {
    expect(validateInstructionInput({ name: 'cloud-agent', content: 'x' })).toBe('reserved');
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

  it('leaves nothing for a name written in another script', () => {
    expect(cleanInstructionName('規則')).toBe('');
  });

  it('truncates to the server bound and drops a trailing dash', () => {
    const cleaned = cleanInstructionName(`${'a'.repeat(INSTRUCTION_NAME_MAX_LENGTH)} tail`);
    expect(cleaned.length).toBeLessThanOrEqual(INSTRUCTION_NAME_MAX_LENGTH);
    expect(cleaned.endsWith('-')).toBe(false);
  });
});

describe('instructionNamePreview', () => {
  it('names the slug a save will store when it differs', () => {
    expect(instructionNamePreview('Release Notes')).toBe('release-notes');
  });

  it('stays silent for a blank or already-normalized name', () => {
    expect(instructionNamePreview('   ')).toBeNull();
    expect(instructionNamePreview('release-notes')).toBeNull();
  });

  it('stays silent when the fold leaves no ASCII name to show', () => {
    expect(instructionNamePreview('規則')).toBeNull();
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
