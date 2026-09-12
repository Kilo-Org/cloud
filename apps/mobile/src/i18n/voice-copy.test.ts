import { describe, expect, it } from 'vitest';

import en from './locales/en.json';

/**
 * Copy for the voice language picker and the voice-input test field. English
 * is the source of truth: the translation slice fills the other catalogs, and
 * this test pins the eight new messages so a rename cannot ship silently.
 */
const VOICE_LANGUAGE_COPY: Array<[keyof typeof en.voiceLanguage, string]> = [
  ['title', 'Voice language'],
  ['automatic', 'Automatic'],
  ['loadFailed', "Couldn't load the languages this device supports."],
  ['emptyTitle', 'No supported languages'],
  ['emptyDescription', "This device's speech recognition reports no supported languages."],
];

const VOICE_INPUT_TEST_COPY: Array<[keyof typeof en.voiceInput, string]> = [
  ['testTitle', 'Test voice input'],
  ['testPlaceholder', 'Tap the microphone and start speaking.'],
  ['testClear', 'Clear text'],
];

describe('voice copy', () => {
  it.each(VOICE_LANGUAGE_COPY)('defines voiceLanguage.%s', (key, value) => {
    expect(en.voiceLanguage[key]).toBe(value);
  });

  it.each(VOICE_INPUT_TEST_COPY)('defines voiceInput.%s', (key, value) => {
    expect(en.voiceInput[key]).toBe(value);
  });

  it('keeps the reused picker and state copy', () => {
    expect(en.common.cancel).toBeTruthy();
    expect(en.common.done).toBeTruthy();
    expect(en.common.retry).toBeTruthy();
    expect(en.common.language).toBeTruthy();
    expect(en.common.loading).toBeTruthy();
    expect(en.language.search).toBeTruthy();
    expect(en.language.noMatches).toBeTruthy();
  });
});
