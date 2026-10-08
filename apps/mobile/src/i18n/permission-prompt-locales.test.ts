import { describe, expect, it } from 'vitest';

import copy from '../../plugins/permission-prompt-copy.json';
import { SUPPORTED_LANGUAGES } from './languages';
import {
  buildPermissionPromptLocales,
  PERMISSION_PROMPT_PLIST_KEYS,
  type PermissionPromptCopy,
} from './permission-prompt-locales';

const locales = buildPermissionPromptLocales(copy);

describe('buildPermissionPromptLocales', () => {
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

  it.each(PERMISSION_PROMPT_PLIST_KEYS)('rejects a missing %s translation', key => {
    const incomplete: PermissionPromptCopy = {
      ...copy,
      de: { ...copy.de, [key]: undefined },
    };
    expect(() => buildPermissionPromptLocales(incomplete)).toThrow(
      `Missing or empty permission prompt copy for de.${key}`
    );
  });
});
