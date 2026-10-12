import { Effect } from 'effect';
import { z } from 'zod';

import { type ApplyLanguageOutcome, applyLanguagePreference } from '@/i18n/apply-language';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import {
  getLanguagePreference,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';

import { changed, failure, invalidValue } from './bindings';
import { type AppSettingEntry } from './types';

/**
 * The language setting, kept out of the catalog table because its write is the
 * one that does more than store a value.
 *
 * Storing the preference is not applying it: the running app reads the language
 * once at startup, so a write that only persists leaves the app in its old
 * language. This runs the manual picker's own apply path instead — the catalog
 * is swapped in place, or the native direction is forced and the app reloads —
 * so the agent's result matches the language the user then sees.
 */

const LANGUAGE_OPTIONS = ['device', ...SUPPORTED_LANGUAGES];
const languageSchema = z.union([z.literal('device'), z.enum(SUPPORTED_LANGUAGES)]);

/** What the model reads back for one apply outcome: applied, or why it was not. */
type LanguageReport =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: string };

/**
 * Every `ApplyLanguageOutcome` kind, so a new one cannot be added without a
 * report. An LTR change and a direction change that restarts the app both
 * applied the language; the rest say what did not happen.
 */
const LANGUAGE_OUTCOME = {
  'applied-ltr': { applied: true },
  'restarting-rtl': { applied: true },
  'persist-failed': { applied: false, reason: 'the language could not be saved to disk' },
  'reload-failed': {
    applied: false,
    reason: 'the language was saved but the app could not restart to apply it',
  },
  'catalog-failed': { applied: false, reason: 'the language catalog could not be loaded' },
} satisfies Record<ApplyLanguageOutcome['kind'], LanguageReport>;

const languageChangeReport = (
  language: LanguagePreference,
  outcome: ApplyLanguageOutcome
): string => {
  const report = LANGUAGE_OUTCOME[outcome.kind];
  if (!report.applied) {
    throw new Error(report.reason);
  }
  return changed('language', language);
};

export const languageEntry: AppSettingEntry = {
  name: 'language',
  description: 'The app language: a supported tag, or "device" to follow the system.',
  kind: 'enum',
  options: LANGUAGE_OPTIONS,
  bind: () => ({
    read: getLanguagePreference,
    write: value => {
      const parsed = languageSchema.safeParse(value);
      if (!parsed.success) {
        return Effect.fail(invalidValue('language', value, LANGUAGE_OPTIONS.join(', ')));
      }
      const language: LanguagePreference = parsed.data;
      return Effect.tryPromise({
        try: async () => {
          const resolved = language === 'device' ? resolveDeviceLanguage() : language;
          // The picker's own path: change the catalog in place, or force the
          // direction and reload. Persisting alone never reaches the screen.
          const outcome = await applyLanguagePreference(language, resolved);
          return languageChangeReport(language, outcome);
        },
        catch: error => failure(`Could not change language: ${String(error)}`),
      });
    },
  }),
};
