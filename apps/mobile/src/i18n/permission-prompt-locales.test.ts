import { describe, expect, it } from 'vitest';

import copy from '../../plugins/permission-prompt-copy.json';
import { SUPPORTED_LANGUAGES } from './languages';
import {
  buildPermissionPromptLocales,
  PERMISSION_PROMPT_PLIST_KEYS,
  type PermissionPromptCopy,
} from './permission-prompt-locales';

const locales = buildPermissionPromptLocales(copy);

// Mirrors the five plugin options in app.config.ts. The en override must match
// the value the system resolves — including `$(PRODUCT_NAME)` expanded to the
// product name — so the base Info.plist value and the .lproj string never
// drift. `.lproj/InfoPlist.strings` is not build-expanded, so the location copy
// spells the name out instead of keeping the variable.
const ENGLISH_PROMPTS = {
  NSMicrophoneUsageDescription: 'Allow Kilo to use your microphone to turn speech into text.',
  NSSpeechRecognitionUsageDescription:
    'Allow Kilo to use speech recognition to turn your voice into text.',
  NSFaceIDUsageDescription: 'Allow Kilo to use Face ID to unlock the app.',
  NSLocationWhenInUseUsageDescription: 'Allow Kilo to use your location to set up local weather.',
  NSUserTrackingUsageDescription:
    'This identifier is used to measure the effectiveness of advertising campaigns.',
};

describe('buildPermissionPromptLocales', () => {
  it('covers exactly the supported languages', () => {
    expect(Object.keys(locales).toSorted()).toEqual(SUPPORTED_LANGUAGES.toSorted());
  });

  it.each(SUPPORTED_LANGUAGES)('fills all five keys in %s', tag => {
    for (const key of PERMISSION_PROMPT_PLIST_KEYS) {
      expect(locales[tag].ios[key].trim().length, `${tag}.${key}`).toBeGreaterThan(0);
    }
  });

  it.each(SUPPORTED_LANGUAGES)('keeps every %s value safe for a .strings file', tag => {
    for (const key of PERMISSION_PROMPT_PLIST_KEYS) {
      expect(locales[tag].ios[key], `${tag}.${key}`).not.toMatch(/["\\\r\n]/);
    }
  });

  // `InfoPlist.strings` is compiled verbatim: Xcode expands `$(PRODUCT_NAME)`
  // only in Info.plist. A value that kept the variable would be shown literally
  // in the prompt, so the copy names the app directly.
  it.each(SUPPORTED_LANGUAGES)('keeps no unexpanded build variable in %s', tag => {
    for (const key of PERMISSION_PROMPT_PLIST_KEYS) {
      expect(locales[tag].ios[key], `${tag}.${key}`).not.toContain('$(');
    }
    expect(locales[tag].ios.NSLocationWhenInUseUsageDescription, tag).toContain('Kilo');
  });

  it('keeps the English override equal to the base plugin options', () => {
    expect(locales.en.ios).toEqual(ENGLISH_PROMPTS);
  });

  it('throws when a supported language has no copy', () => {
    const { de: _de, ...rest } = copy;
    const incomplete: PermissionPromptCopy = rest;
    expect(() => buildPermissionPromptLocales(incomplete)).toThrow(
      'Missing permission prompt copy for language: de'
    );
  });

  it('throws when any key is empty', () => {
    const incomplete: PermissionPromptCopy = {
      ...copy,
      de: { ...copy.de, NSFaceIDUsageDescription: '   ' },
    };
    expect(() => buildPermissionPromptLocales(incomplete)).toThrow(
      'Missing or empty permission prompt copy for de.NSFaceIDUsageDescription'
    );
  });
});
