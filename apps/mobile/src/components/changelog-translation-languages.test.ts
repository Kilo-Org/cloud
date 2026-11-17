import { describe, expect, it } from 'vitest';

import { translationLanguagesIn } from './changelog-translation-languages';

describe('translationLanguagesIn', () => {
  it('names the language a catalog fix corrected, in the picker’s English name', () => {
    expect(translationLanguagesIn('correct the Igbo code reviewer copy')).toEqual(['Igbo']);
    expect(translationLanguagesIn('align the Pashto profile settings and setup copy')).toEqual([
      'Pashto',
    ]);
  });

  it('keeps the order the subject names the languages in and names each once', () => {
    expect(translationLanguagesIn('correct pt-BR, Japanese and German action labels')).toEqual([
      'Portuguese (Brazil)',
      'Japanese',
      'German',
    ]);
    expect(translationLanguagesIn('align Armenian and Armenian copy')).toEqual(['Armenian']);
  });

  it('prefers the longer name when one contains another', () => {
    expect(translationLanguagesIn('correct Simplified Chinese agent chat copy')).toEqual([
      'Chinese (Simplified)',
    ]);
    expect(translationLanguagesIn('correct Malayalam voice input copy')).toEqual(['Malayalam']);
  });

  it('leaves English out: it is the source the notes are written in', () => {
    expect(
      translationLanguagesIn('align Estonian code reviewer copy with its English source')
    ).toEqual(['Estonian']);
    expect(translationLanguagesIn('correct the English label')).toEqual([]);
  });

  it('names no language for a subject that mentions none', () => {
    expect(translationLanguagesIn('keep the composer visible')).toEqual([]);
    expect(translationLanguagesIn('name the auto-merge method in the reader’s language')).toEqual(
      []
    );
  });
});
