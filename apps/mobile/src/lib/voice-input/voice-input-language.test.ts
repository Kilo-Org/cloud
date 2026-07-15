import { describe, expect, it } from 'vitest';

import { resolveVoiceInputLanguageTag } from './voice-input-language';

describe('resolveVoiceInputLanguageTag', () => {
  it('falls back to en-US when the locales array is empty', () => {
    expect(resolveVoiceInputLanguageTag([])).toBe('en-US');
  });

  it('falls back to en-US when the first locale has no languageTag', () => {
    expect(resolveVoiceInputLanguageTag([{}])).toBe('en-US');
  });

  it('falls back to en-US when the first locale languageTag is empty', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: '' }])).toBe('en-US');
  });

  it('returns the first locale languageTag when it is populated', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: 'nl-NL' }])).toBe('nl-NL');
  });

  it('ignores later locales', () => {
    expect(resolveVoiceInputLanguageTag([{ languageTag: 'fr-FR' }, { languageTag: 'de-DE' }])).toBe(
      'fr-FR'
    );
  });
});
